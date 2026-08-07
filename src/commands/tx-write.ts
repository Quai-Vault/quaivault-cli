import { keccak256 } from 'quais';
import type { AbiSource, ExecuteOutcome, ExecuteResult, VaultTransaction } from '@quaivault/sdk';
import type { CommandSpec, WritePlan } from '../cli/spec.js';
import { ExitCode, type ExitCodeValue } from '../cli/exit.js';
import { PreconditionError, type AppContext } from '../context/context.js';
import { checkPolicy } from '../context/policy.js';
import { span } from '../format/tone.js';
import { formatAbsolute, formatDuration, safeText } from '../format/index.js';
import type { Io } from '../render/io.js';
import { batchOf, renderDisclosure } from '../render/transaction.js';
import { isUnverified, type BatchAnalysis } from '../abi/batch.js';
import { resolveTxHash } from './tx-read.js';
import { transactionFingerprint, transactionFromChain } from '../sdk/chain-transaction.js';
import { recentPolicyActionCount, recordPolicyAction } from '../context/policy-journal.js';

interface LifecycleInput {
  vault?: string;
  hash: string;
  expectDataHash?: string;
  expectTo?: string;
  expectValue?: string;
  expectAbiSource?: string;
  andExecute?: boolean;
}

interface Disclosure {
  tx: VaultTransaction;
  address: string;
  action: string;
  unverified: boolean;
  /** Null when the transaction is not a batch. */
  batch: BatchAnalysis | null;
  fingerprint: string;
}

const EXPECT_OPTIONS = [
  {
    flags: '--expect-data-hash <hex>',
    description: 'fail unless the calldata hashes to this (bind to bytes, not prose)',
  },
  { flags: '--expect-to <address>', description: 'fail unless the recipient matches' },
  { flags: '--expect-value <wei>', description: 'fail unless the value matches, in wei' },
  {
    flags: '--expect-abi-source <source>',
    description: 'fail unless the decode provenance matches',
  },
];

/**
 * Build the pre-signature disclosure from **chain** state.
 *
 * This is `plan()` in the plan/commit split: a pure read producing everything a
 * reviewer needs. Nothing here signs, so `--dry-run` is this and nothing else.
 */
async function planLifecycle(
  ctx: AppContext,
  input: LifecycleInput,
  action: string,
): Promise<WritePlan<Disclosure> & { unverified: boolean }> {
  const address = ctx.resolveVault(input.vault);
  const hash = await resolveTxHash(ctx, address, input.hash);
  const tx = await transactionFromChain(ctx, address, hash);

  // Assertion flags: an agent that decides from prose is injection-vulnerable
  // by construction, so it binds to the bytes instead (plan §3.4).
  assertExpectations(tx, input);

  // The batch analysis is what makes the delegatecall gate real: the vault's
  // transaction struct has no operation field, so a delegatecall can only
  // ever be a MultiSend sub-call (§7, src/abi/batch.ts).
  const batch = batchOf(tx, ctx);
  const unverified = isUnverified(tx.abiSource, batch);

  // Policy applies to non-interactive signing only; an attended human is bound
  // by the disclosure and the prompt, not by a file.
  enforceLifecyclePolicy(ctx, tx, batch, action);

  return {
    disclosure: {
      tx,
      address,
      action,
      unverified,
      batch,
      fingerprint: transactionFingerprint(tx),
    },
    dataHash: keccak256(tx.data === '0x' ? '0x' : tx.data),
    summary: `${action} ${safeText(tx.summary, 120)}`,
    unverified,
  };
}

function enforceLifecyclePolicy(
  ctx: AppContext,
  tx: VaultTransaction,
  batch: BatchAnalysis | null,
  action: string,
): void {
  if (ctx.policy && (ctx.flags.yes || !ctx.interactive)) {
    const violations = checkPolicy(ctx.policy, {
      value: tx.value,
      to: tx.to,
      kind: tx.kind,
      isDelegatecall: batch?.hasDelegatecall ?? false,
      abiSource: batch ? worstOf(tx.abiSource, batch.abiSource) : tx.abiSource,
      approvalsLastHour: recentPolicyActionCount(ctx.profileName, 'approve', ctx.now()),
      countTowardApprovalLimit: action === 'approve',
      effects: policyEffects(tx, batch),
    });
    if (violations.length) {
      throw new PreconditionError(
        `Refused by policy: ${violations.map((v) => v.rule).join(', ')}`,
        violations.map((v) => v.message).join('\n  '),
      );
    }
  }
}

function policyEffects(
  tx: VaultTransaction,
  batch: BatchAnalysis | null,
): { to: string; value: bigint; kind: string }[] {
  const effect = (
    fallbackTo: string,
    value: bigint,
    kind: string,
    decoded?: VaultTransaction['decoded'],
  ) => {
    const recipient = decoded?.args.to;
    return {
      to: typeof recipient === 'string' ? recipient : fallbackTo,
      value,
      kind,
    };
  };
  if (!batch) return [effect(tx.to, tx.value, tx.kind, tx.decoded)];
  return batch.calls.map((call) =>
    effect(
      call.to,
      call.value,
      call.decoded?.target === 'erc20'
        ? 'erc20_transfer'
        : call.decoded?.target === 'erc721'
          ? 'erc721_transfer'
          : call.decoded?.target === 'erc1155'
            ? 'erc1155_transfer'
            : call.value > 0n && call.data === '0x'
              ? 'transfer'
              : 'external_call',
      call.decoded,
    ),
  );
}

/** Close the review/signing TOCTOU window and reapply every agent assertion. */
async function revalidateLifecycle(
  ctx: AppContext,
  planned: WritePlan<Disclosure>,
  input: LifecycleInput,
): Promise<VaultTransaction> {
  const d = planned.disclosure;
  const fresh = await transactionFromChain(ctx, d.address, d.tx.hash);
  if (transactionFingerprint(fresh) !== d.fingerprint) {
    throw new PreconditionError(
      'The transaction changed between review and signing.',
      'Nothing was signed. Review the transaction again.',
    );
  }
  assertExpectations(fresh, input);
  enforceLifecyclePolicy(ctx, fresh, batchOf(fresh, ctx), d.action);
  return fresh;
}

/**
 * The weaker of two provenances, so `require_abi_source = ["builtin"]` cannot
 * be satisfied by an outer `multiSend` that the SDK vouches for while the
 * sub-calls inside it are guesses.
 */
function worstOf(outer: AbiSource, inner: AbiSource): AbiSource {
  const order: AbiSource[] = ['builtin', 'supplied', 'heuristic', 'none'];
  return order.indexOf(inner) > order.indexOf(outer) ? inner : outer;
}

function assertExpectations(tx: VaultTransaction, input: LifecycleInput): void {
  const fail = (what: string, expected: string, actual: string): never => {
    throw new PreconditionError(
      `${what} does not match --expect: expected ${expected}, found ${actual}.`,
      'Nothing was signed. Re-read the transaction and retry with the correct expectation.',
    );
  };
  if (input.expectTo && input.expectTo.toLowerCase() !== tx.to.toLowerCase()) {
    fail('Recipient', input.expectTo, tx.to);
  }
  if (input.expectValue !== undefined && BigInt(input.expectValue) !== tx.value) {
    fail('Value', input.expectValue, tx.value.toString(10));
  }
  if (input.expectAbiSource && input.expectAbiSource !== tx.abiSource) {
    fail('Decode provenance', input.expectAbiSource, tx.abiSource);
  }
  if (input.expectDataHash) {
    const actual = keccak256(tx.data === '0x' ? '0x' : tx.data);
    if (actual.toLowerCase() !== input.expectDataHash.toLowerCase()) {
      fail('Calldata hash', input.expectDataHash, actual);
    }
  }
}

function renderPlanned(planned: WritePlan<Disclosure>, io: Io, ctx: AppContext): void {
  const d = planned.disclosure;
  renderDisclosure(d.tx, io, ctx, { title: `About to ${d.action}:`, batch: d.batch });
  if (d.unverified) {
    io.out('');
    io.out(
      io.paint(
        span(
          d.batch?.hasDelegatecall
            ? '  This batch contains a delegatecall — a sub-call can rewrite vault storage.'
            : '  This decode is not one the SDK vouches for.',
          'danger',
        ),
      ),
    );
    io.out(io.paint(span('  Read the raw calldata above before continuing.', 'danger')));
  }
}

// ------------------------------------------------------------------ outcomes

/**
 * A successful receipt does not mean the vault transaction executed. All four
 * outcomes render distinctly and map to distinct exit codes (plan §4.1).
 */
function outcomeExit(outcome: ExecuteOutcome): ExitCodeValue {
  switch (outcome) {
    case 'executed':
      return ExitCode.Ok;
    case 'failed':
      // The chain transaction succeeded; the vault call did not. Terminal.
      return ExitCode.Failure;
    case 'approved_only':
    case 'timelock_started':
      return ExitCode.NotExecuted;
    default: {
      const never: never = outcome;
      throw new Error(`unhandled outcome: ${String(never)}`);
    }
  }
}

type OutcomeView = Pick<ExecuteResult, 'outcome'> &
  Partial<Pick<ExecuteResult, 'chainTxHash' | 'message' | 'decodedRevert' | 'executableAfter' | 'approvalsNeeded'>>;

function renderOutcome(result: OutcomeView, io: Io, ctx: AppContext): void {
  const outcome = result.outcome;
  switch (outcome) {
    case 'executed':
      io.out(io.paint(span('  EXECUTED', 'ok')));
      io.out(`  ${safeText(result.message, 300)}`);
      break;
    case 'failed':
      io.out(io.paint(span('  FAILED — the vault transaction did not execute.', 'danger')));
      if (result.decodedRevert) {
        io.out('');
        io.out(`  The target call reverted:`);
        io.out(`    ${safeText(result.decodedRevert.message, 300)}`);
      }
      io.out('');
      io.out('  This is terminal. The vault has permanently marked this transaction');
      io.out('  executed and it cannot be retried. Propose a replacement.');
      io.err('');
      io.err('  The Quai transaction succeeded; the vault call did not — which is why');
      io.err('  this exits non-zero.');
      break;
    case 'timelock_started':
      io.out(io.paint(span('  TIMELOCK STARTED — nothing executed.', 'warn')));
      io.out('');
      io.out('  This transaction reached quorum without its timelock clock running.');
      if (result.executableAfter) {
        io.out(
          `  Executable in ${formatDuration(result.executableAfter - ctx.now())}, at ${formatAbsolute(result.executableAfter)}.`,
        );
      }
      break;
    case 'approved_only':
      io.out(io.paint(span('  APPROVED ONLY — your approval landed; execution did not run.', 'warn')));
      if (result.approvalsNeeded !== undefined) {
        io.out(`  Still needs ${result.approvalsNeeded} more approval(s).`);
      }
      break;
    default: {
      // ExecuteResult is a flat interface, so the exhaustiveness assert has to
      // sit on the union field rather than the object.
      const never: never = outcome;
      throw new Error(`unhandled outcome: ${String(never)}`);
    }
  }
  if (result.chainTxHash) io.out(`  chain ${result.chainTxHash}`);
}

// ------------------------------------------------------------------ commands

interface WriteResult {
  hash: string;
  address: string;
  chainTxHash?: string;
  outcome?: ExecuteOutcome;
  message?: string;
  alreadyDone?: boolean;
}

function baseWriteJson(r: { data: WriteResult }): Record<string, unknown> {
  return {
    transactionHash: r.data.hash,
    vault: r.data.address,
    chainTxHash: r.data.chainTxHash ?? null,
    outcome: r.data.outcome ?? null,
    message: r.data.message ?? null,
  };
}

const writeSchema = {
  type: 'object',
  properties: {
    transactionHash: { type: 'string' },
    vault: { type: 'string' },
    chainTxHash: { type: ['string', 'null'], description: 'present even on failure' },
    outcome: {
      type: ['string', 'null'],
      enum: ['executed', 'failed', 'timelock_started', 'approved_only', null],
    },
  },
};

export const txApproveCommand: CommandSpec<LifecycleInput, WriteResult, Disclosure> = {
  path: ['tx', 'approve'],
  describe: 'Approve a pending transaction',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: [
    ...EXPECT_OPTIONS,
    {
      flags: '--and-execute',
      description: 'execute in the same transaction if this approval meets the threshold',
      defaultValue: false,
    },
  ],
  needs: { signer: true },

  plan: (ctx, input) => planLifecycle(ctx, input, 'approve'),
  renderPlan: renderPlanned,
  planToJson: lifecyclePlanJson,

  async commit(ctx, planned, input) {
    const address = planned.disclosure.address;
    const tx = await revalidateLifecycle(ctx, planned, input);
    const vault = ctx.qv.vault(address);
    const { address: signerAddress } = await ctx.requireSigner();

    // Idempotency: re-running an approval that already landed is a no-op, not
    // a failure. An agent retrying after a timeout depends on this.
    const already = tx.approvals.some(
      (a) => a.active && a.owner.toLowerCase() === signerAddress.toLowerCase(),
    );
    if (already) {
      return {
        data: { hash: tx.hash, address, alreadyDone: true },
        changed: false,
        retryable: false,
        steps: [{ name: 'approve', status: 'skipped' }],
      };
    }

    if (input.andExecute) {
      if (tx.executionDelay > 0) {
        throw new PreconditionError(
          'This vault has a timelock, so approve-and-execute cannot run in one transaction.',
          'Approve now, then `qv tx execute` once the timelock clears.',
        );
      }
      const result = await vault.approveAndExecute(tx.hash);
      if (ctx.policy && (ctx.flags.yes || !ctx.interactive)) {
        recordPolicyAction({
          at: ctx.now(),
          profile: ctx.profileName,
          action: 'approve',
          vault: address,
          transactionHash: tx.hash,
          chainTxHash: result.chainTxHash,
        });
      }
      return {
        data: {
          hash: tx.hash,
          address,
          chainTxHash: result.chainTxHash,
          outcome: result.outcome,
          message: result.message,
        },
        changed: true,
        retryable: result.outcome === 'approved_only' || result.outcome === 'timelock_started',
        steps: [
          { name: 'approve', status: 'ok', chainTxHash: result.chainTxHash },
          {
            name: 'execute',
            status: result.outcome === 'executed' ? 'ok' : 'failed',
            chainTxHash: result.chainTxHash,
          },
        ],
        exitCode: outcomeExit(result.outcome),
      };
    }

    const { chainTxHash } = await vault.approve(tx.hash);
    if (ctx.policy && (ctx.flags.yes || !ctx.interactive)) {
      recordPolicyAction({
        at: ctx.now(),
        profile: ctx.profileName,
        action: 'approve',
        vault: address,
        transactionHash: tx.hash,
        chainTxHash,
      });
    }
    // §4.1: an indexer stall after a successful write exits 0 — exiting
    // non-zero invites a retry of a multisig transaction that already
    // succeeded. But it must still be *said*, or the next `qv tx show`
    // looks stale for no visible reason.
    const reached = await vault
      .waitForIndexer()
      .then((r) => r.reached)
      .catch(() => false);
    return {
      data: { hash: tx.hash, address, chainTxHash },
      changed: true,
      retryable: false,
      steps: [{ name: 'approve', status: 'ok', chainTxHash }],
      next: [`qv tx show ${address} ${tx.hash}`],
      warnings: reached ? undefined : ['The write landed on chain but the indexer has not caught up yet. `qv tx show` may lag by a few seconds; do not re-run this command.'],
    };
  },

  render(result, io) {
    if (result.data.alreadyDone) {
      io.out('  Already approved by this key — nothing to do.');
      return;
    }
    io.out(io.paint(span('  APPROVED', 'ok')));
    if (result.data.outcome) {
      io.out('');
    }
    if (result.data.chainTxHash) io.out(`  chain ${result.data.chainTxHash}`);
  },
  toJson: (r) => ({ ...baseWriteJson(r), alreadyApproved: r.data.alreadyDone ?? false }),
  outputSchema: writeSchema,
};

export const txUnapproveCommand: CommandSpec<LifecycleInput, WriteResult, Disclosure> = {
  path: ['tx', 'unapprove'],
  describe: 'Withdraw your approval (aliased as revoke)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planLifecycle(ctx, input, 'withdraw approval from'),
  renderPlan: renderPlanned,
  planToJson: lifecyclePlanJson,
  async commit(ctx, planned, input) {
    const address = planned.disclosure.address;
    const tx = await revalidateLifecycle(ctx, planned, input);
    const { chainTxHash } = await ctx.qv.vault(address).revokeApproval(tx.hash);
    return {
      data: { hash: tx.hash, address, chainTxHash },
      changed: true,
      steps: [{ name: 'revokeApproval', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  approval withdrawn   chain ${r.data.chainTxHash ?? '?'}`),
  toJson: (r) => baseWriteJson(r) as never,
  outputSchema: writeSchema,
};

export const txExecuteCommand: CommandSpec<LifecycleInput, WriteResult, Disclosure> = {
  path: ['tx', 'execute'],
  describe: 'Execute an approved transaction',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planLifecycle(ctx, input, 'execute'),
  renderPlan: renderPlanned,
  planToJson: lifecyclePlanJson,

  async commit(ctx, planned, input) {
    const address = planned.disclosure.address;
    const tx = await revalidateLifecycle(ctx, planned, input);
    const vault = ctx.qv.vault(address);
    const result = await vault.execute(tx.hash);

    // An indexer that has not caught up after a successful write must exit 0:
    // exiting non-zero invites a script to retry a multisig transaction that
    // already succeeded (plan §4.1).
    const reached = await vault
      .waitForIndexer()
      .then((r) => r.reached)
      .catch(() => false);

    return {
      data: {
        hash: tx.hash,
        address,
        chainTxHash: result.chainTxHash,
        outcome: result.outcome,
        message: result.message,
      },
      changed: result.outcome === 'executed' || result.outcome === 'timelock_started',
      retryable: result.outcome === 'timelock_started' || result.outcome === 'approved_only',
      steps: [
        {
          name: 'execute',
          status: result.outcome === 'executed' ? 'ok' : 'failed',
          chainTxHash: result.chainTxHash,
        },
      ],
      warnings: reached
        ? undefined
        : ['The transaction landed on chain but the indexer has not caught up yet.'],
      exitCode: outcomeExit(result.outcome),
    };
  },

  render(result, io, ctx) {
    const r = result.data;
    if (!r.outcome) {
      io.out('  executed');
      return;
    }
    renderOutcome({ outcome: r.outcome, chainTxHash: r.chainTxHash, message: r.message }, io, ctx);
  },
  toJson: (r) => baseWriteJson(r) as never,
  outputSchema: writeSchema,
};

export const txCancelCommand: CommandSpec<LifecycleInput, WriteResult, Disclosure> = {
  path: ['tx', 'cancel'],
  describe: 'Cancel a transaction you proposed (proposer-cancel only)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planLifecycle(ctx, input, 'cancel'),
  renderPlan: renderPlanned,
  planToJson: lifecyclePlanJson,

  async commit(ctx, planned, input) {
    const address = planned.disclosure.address;
    const tx = await revalidateLifecycle(ctx, planned, input);
    // Past quorum this is a different operation entirely — a new proposal
    // needing its own approval round. Never silently escalate one into the
    // other.
    if (tx.approvedAt > 0) {
      throw new PreconditionError(
        'This transaction has reached quorum, so proposer-cancel is permanently blocked.',
        `Cancelling now needs owner consensus: qv propose cancel-by-consensus ${address} ${tx.hash}`,
      );
    }
    const { chainTxHash } = await ctx.qv.vault(address).cancel(tx.hash);
    return {
      data: { hash: tx.hash, address, chainTxHash },
      changed: true,
      steps: [{ name: 'cancel', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  cancelled   chain ${r.data.chainTxHash ?? '?'}`),
  toJson: (r) => baseWriteJson(r) as never,
  outputSchema: writeSchema,
};

export const txExpireCommand: CommandSpec<LifecycleInput, WriteResult, Disclosure> = {
  path: ['tx', 'expire'],
  describe: 'Mark an expired transaction as expired (permissionless cleanup)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planLifecycle(ctx, input, 'expire'),
  renderPlan: renderPlanned,
  planToJson: lifecyclePlanJson,
  async commit(ctx, planned, input) {
    const address = planned.disclosure.address;
    const tx = await revalidateLifecycle(ctx, planned, input);
    const { chainTxHash } = await ctx.qv.vault(address).expire(tx.hash);
    return {
      data: { hash: tx.hash, address, chainTxHash },
      changed: true,
      steps: [{ name: 'expire', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  expired   chain ${r.data.chainTxHash ?? '?'}`),
  toJson: (r) => baseWriteJson(r) as never,
  outputSchema: writeSchema,
};

function lifecyclePlanJson(planned: WritePlan<Disclosure>) {
  const { tx, address, action, unverified, batch } = planned.disclosure;
  return {
    action,
    vault: address,
    transactionHash: tx.hash,
    to: tx.to,
    value: tx.value.toString(10),
    data: tx.data,
    dataHash: planned.dataHash ?? null,
    abiSource: tx.abiSource,
    unverified,
    batch: batch
      ? {
          unreadable: batch.error ?? null,
          hasDelegatecall: batch.hasDelegatecall,
          calls: batch.calls.map((call) => ({
            operation: call.operation,
            to: call.to,
            value: call.value.toString(10),
            data: call.data,
            abiSource: call.abiSource,
          })),
        }
      : null,
  };
}

export { outcomeExit, planLifecycle, assertExpectations };
