import { inspectAddress, type RecoveryRequest, type RecoveryConfig } from '@quaivault/sdk';
import type { CommandSpec, WritePlan } from '../cli/spec.js';
import { cacheKey } from '../store/index.js';
import { PreconditionError, UsageError, type AppContext } from '../context/context.js';
import { promptTyped } from '../cli/confirm.js';
import { span } from '../format/tone.js';
import { formatAbsolute, formatDuration, safeText } from '../format/index.js';
import type { Io } from '../render/io.js';

/**
 * Recovery friction is deliberately the inverse of the pattern in Appendix A.
 *
 * `execute` replaces the **entire owner set and threshold** — it takes a typed
 * confirmation. `cancel` is the owners' defence against a hostile or mistaken
 * guardian action — it takes nothing at all. Getting this backwards is the
 * specific mistake being corrected.
 */

interface RecoveryStatusData {
  address: string;
  config: RecoveryConfig | null;
  pending: RecoveryRequest[];
  enabled: boolean;
}

export const recoveryStatusCommand: CommandSpec<{ vault?: string }, RecoveryStatusData> = {
  path: ['recovery', 'status'],
  key: (input) => cacheKey(['recovery', 'status'], input.vault),
  invalidatedBy: ['recoveries'],
  scopeVault: (input) => input.vault,
  describe: 'Guardian configuration and any pending recovery',
  args: [{ name: 'vault', description: 'vault alias or address' }],

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const recovery = ctx.qv.vault(address).recovery;
    const enabled = await recovery.isEnabled();
    const [config, pending] = await Promise.all([
      enabled ? recovery.config() : Promise.resolve(null),
      enabled ? recovery.pending() : Promise.resolve([]),
    ]);
    return { data: { address, config, pending, enabled }, changed: false };
  },

  render(result, io, ctx) {
    const { config, pending, enabled } = result.data;
    if (!enabled) {
      io.out('  Social recovery is not enabled on this vault.');
      return;
    }
    if (config) {
      io.out(`  Guardians    ${config.threshold} of ${config.guardians.length}`);
      for (const g of config.guardians) {
        const name = ctx.contactName(g);
        io.out(`    ${g}${name ? `   ${safeText(name, 40)}` : ''}`);
      }
      io.out(`  Period       ${formatDuration(config.recoveryPeriod)}`);
    }
    if (!pending.length) {
      io.out('');
      io.out('  No pending recovery.');
      return;
    }
    for (const r of pending) {
      io.out('');
      io.out(io.paint(span('  PENDING RECOVERY', 'danger')));
      io.out(`    hash        ${r.hash}`);
      io.out(`    approvals   ${r.approvalCount} of ${r.requiredThreshold}`);
      io.out(`    new owners  ${r.newThreshold} of ${r.newOwners.length}`);
      for (const o of r.newOwners) io.out(`      ${o}`);
      const left = r.executionTime - ctx.now();
      io.out(
        `    executable  ${left > 0 ? `in ${formatDuration(left)} (${formatAbsolute(r.executionTime)})` : io.paint(span('NOW', 'danger'))}`,
      );
      io.out('');
      io.out(io.paint(span(`    Any current owner can stop this:`, 'danger')));
      io.out(io.paint(span(`      qv recovery cancel ${result.data.address} ${r.hash}`, 'danger')));
    }
  },

  toJson: (r) => ({
    vault: r.data.address,
    enabled: r.data.enabled,
    config: r.data.config
      ? {
          guardians: r.data.config.guardians,
          threshold: r.data.config.threshold,
          recoveryPeriod: r.data.config.recoveryPeriod,
        }
      : null,
    pending: r.data.pending.map((p) => ({
      hash: p.hash,
      newOwners: p.newOwners,
      newThreshold: p.newThreshold,
      approvalCount: p.approvalCount,
      requiredThreshold: p.requiredThreshold,
      executionTime: p.executionTime,
      expiration: p.expiration,
      status: p.status,
    })),
  }),

  outputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string' },
      enabled: { type: 'boolean' },
      config: { type: ['object', 'null'] },
      pending: { type: 'array' },
    },
  },
};

export const recoveryHistoryCommand: CommandSpec<
  { vault?: string },
  { address: string; history: RecoveryRequest[]; degraded: boolean }
> = {
  path: ['recovery', 'history'],
  describe: 'Past recoveries on this vault',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  needs: { indexer: 'required' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    try {
      const history = await ctx.qv.vault(address).recovery.history();
      return { data: { address, history, degraded: false }, changed: false };
    } catch (err) {
      // `history()` throws NoIndexerError rather than returning [] — the
      // correct signal, but it must not propagate as a crash.
      if ((err as { code?: string }).code === 'NO_INDEXER') {
        return { data: { address, history: [], degraded: true }, changed: false };
      }
      throw err;
    }
  },

  render(result, io) {
    if (result.data.degraded) {
      io.out('  Cannot see recovery history (indexer unavailable).');
      return;
    }
    if (!result.data.history.length) {
      io.out('  No recoveries on record.');
      return;
    }
    for (const r of result.data.history) {
      io.out(`  ${r.hash.slice(2, 10)}  ${r.status.padEnd(10)} ${r.newThreshold} of ${r.newOwners.length}`);
    }
  },
  toJson: (r) => ({
    vault: r.data.address,
    degraded: r.data.degraded,
    history: r.data.history.map((h) => ({ hash: h.hash, status: h.status })),
  }),
  outputSchema: {
    type: 'object',
    properties: { vault: { type: 'string' }, degraded: { type: 'boolean' }, history: { type: 'array' } },
  },
};

// ------------------------------------------------------------------- writes

interface RecoveryWriteInput {
  vault?: string;
  hash: string;
  expectNewOwners?: string;
  expectNewThreshold?: string;
  expectExecutionTime?: string;
}

interface RecoveryDisclosure {
  address: string;
  request: RecoveryRequest | null;
  action: string;
  fingerprint?: string;
}

interface RecoveryWriteData {
  hash: string;
  vault: string;
  chainTxHash?: string;
  alreadyDone?: boolean;
}

const RECOVERY_EXPECT_OPTIONS = [
  { flags: '--expect-new-owners <addresses>', description: 'comma-separated exact replacement owner set' },
  { flags: '--expect-new-threshold <n>', description: 'exact replacement threshold' },
  { flags: '--expect-execution-time <unix>', description: 'exact recovery execution timestamp' },
];

async function planRecovery(
  ctx: AppContext,
  input: RecoveryWriteInput,
  action: string,
): Promise<WritePlan<RecoveryDisclosure>> {
  const address = ctx.resolveVault(input.vault);
  const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
  const request = await ctx.qv.vault(address).recovery.get(hash);
  assertRecoveryExpectations(request, input);
  if (ctx.policy && (ctx.flags.yes || !ctx.interactive) && !ctx.policy.allowRecoveryActions.includes(action)) {
    throw new PreconditionError(
      `Recovery action "${action}" is not permitted by policy.`,
      'Add it to allow_recovery_actions only after reviewing the authority it grants.',
    );
  }
  return {
    disclosure: { address, request, action, fingerprint: recoveryFingerprint(request) },
    summary: `${action} recovery ${hash.slice(0, 10)}`,
  };
}

function recoveryFingerprint(request: RecoveryRequest): string {
  return JSON.stringify({
    hash: request.hash.toLowerCase(),
    newOwners: request.newOwners.map((owner) => owner.toLowerCase()).sort(),
    newThreshold: request.newThreshold,
    requiredThreshold: request.requiredThreshold,
    executionTime: request.executionTime,
    expiration: request.expiration,
  });
}

async function revalidateRecovery(
  ctx: AppContext,
  planned: WritePlan<RecoveryDisclosure>,
  input: RecoveryWriteInput,
): Promise<RecoveryRequest> {
  const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
  const fresh = await ctx.qv.vault(planned.disclosure.address).recovery.get(hash);
  if (
    planned.disclosure.fingerprint &&
    recoveryFingerprint(fresh) !== planned.disclosure.fingerprint
  ) {
    throw new PreconditionError(
      'The recovery request changed between review and signing.',
      'Nothing was signed. Review the recovery again.',
    );
  }
  assertRecoveryExpectations(fresh, input);
  return fresh;
}

function assertRecoveryExpectations(request: RecoveryRequest, input: RecoveryWriteInput): void {
  if (input.expectNewOwners) {
    const expected = input.expectNewOwners.split(',').map((value) => value.trim().toLowerCase()).sort();
    const actual = request.newOwners.map((value) => value.toLowerCase()).sort();
    if (expected.join(',') !== actual.join(',')) {
      throw new PreconditionError('Recovery owner set does not match --expect-new-owners.');
    }
  }
  if (input.expectNewThreshold !== undefined && Number(input.expectNewThreshold) !== request.newThreshold) {
    throw new PreconditionError('Recovery threshold does not match --expect-new-threshold.');
  }
  if (input.expectExecutionTime !== undefined && Number(input.expectExecutionTime) !== request.executionTime) {
    throw new PreconditionError('Recovery time does not match --expect-execution-time.');
  }
}

function recoveryPlanJson(planned: WritePlan<RecoveryDisclosure>) {
  const request = planned.disclosure.request;
  return {
    action: planned.disclosure.action,
    vault: planned.disclosure.address,
    recovery: request
      ? {
          hash: request.hash,
          newOwners: request.newOwners,
          newThreshold: request.newThreshold,
          approvalCount: request.approvalCount,
          requiredThreshold: request.requiredThreshold,
          executionTime: request.executionTime,
          expiration: request.expiration,
          status: request.status,
        }
      : null,
  };
}

const recoveryWriteSchema = {
  type: 'object',
  required: ['hash', 'vault', 'chainTxHash'],
  properties: {
    hash: { type: 'string' },
    vault: { type: 'string' },
    chainTxHash: { type: ['string', 'null'] },
    alreadyDone: { type: 'boolean' },
  },
};

const recoveryWriteJson = (r: { data: RecoveryWriteData }) => ({
  hash: r.data.hash,
  vault: r.data.vault,
  chainTxHash: r.data.chainTxHash ?? null,
  alreadyDone: r.data.alreadyDone ?? false,
});

function renderRecoveryPlan(
  planned: WritePlan<RecoveryDisclosure>,
  io: Io,
  ctx: AppContext,
): void {
  const r = planned.disclosure.request;
  io.out('');
  io.out(io.paint(span(`About to ${planned.disclosure.action} a recovery`, 'accent')));
  if (!r) {
    io.out('  (could not read the recovery record)');
    return;
  }
  io.out(`  hash        ${r.hash}`);
  io.out(`  approvals   ${r.approvalCount} of ${r.requiredThreshold}`);
  io.out('');
  io.out(io.paint(span('  This REPLACES the entire owner set with:', 'danger')));
  for (const o of r.newOwners) io.out(io.paint(span(`    ${o}`, 'danger')));
  io.out(io.paint(span(`  New threshold: ${r.newThreshold} of ${r.newOwners.length}`, 'danger')));
  void ctx;
}

export const recoveryApproveCommand: CommandSpec<RecoveryWriteInput, RecoveryWriteData, RecoveryDisclosure> = {
  path: ['recovery', 'approve'],
  describe: 'Approve a pending recovery (guardians only)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  options: RECOVERY_EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planRecovery(ctx, input, 'approve'),
  renderPlan: renderRecoveryPlan,
  planToJson: recoveryPlanJson,
  async commit(ctx, planned, input) {
    const { address: signer } = await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    const recovery = ctx.qv.vault(planned.disclosure.address).recovery;
    await revalidateRecovery(ctx, planned, input);
    const affordances = await recovery.affordances(hash, signer);
    const approval = affordances.find((item) => item.action === 'approve');
    if (!approval?.allowed && approval?.blockedBy === 'already_approved') {
      return {
        data: { hash, vault: planned.disclosure.address, alreadyDone: true },
        changed: false,
        retryable: false,
        steps: [{ name: 'approveRecovery', status: 'skipped' }],
      };
    }
    if (!approval?.allowed) throw new PreconditionError(approval?.reason ?? 'Recovery approval is not allowed.');
    const { chainTxHash } = await recovery.approve(hash);
    return {
      data: { hash, vault: planned.disclosure.address, chainTxHash },
      changed: true,
      retryable: false,
      steps: [{ name: 'approveRecovery', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  recovery approved   ${r.data.hash}`),
  toJson: recoveryWriteJson,
  outputSchema: recoveryWriteSchema,
};

export const recoveryExecuteCommand: CommandSpec<RecoveryWriteInput, RecoveryWriteData, RecoveryDisclosure> = {
  path: ['recovery', 'execute'],
  describe: 'Execute a recovery — replaces every owner',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  options: RECOVERY_EXPECT_OPTIONS,
  needs: { signer: true },
  plan: (ctx, input) => planRecovery(ctx, input, 'execute'),
  renderPlan: renderRecoveryPlan,
  planToJson: recoveryPlanJson,

  async commit(ctx, planned, input) {
    const alias =
      Object.entries(ctx.config.aliases).find(
        ([, v]) => v.toLowerCase() === planned.disclosure.address.toLowerCase(),
      )?.[0] ?? planned.disclosure.address;

    // The highest-consequence command in the product. A typed confirmation,
    // never a bare y/N — and --yes does not skip it.
    if (ctx.interactive) {
      ctx.io.err('');
      ctx.io.err('This replaces every owner of the vault. It cannot be undone.');
      const ok = await promptTyped(`Type the vault name (${alias}) to confirm: `, alias);
      if (!ok) throw new UsageError('Confirmation did not match. Nothing was executed.');
    } else if (!ctx.flags.yes) {
      throw new PreconditionError(
        'Executing a recovery needs confirmation and there is no terminal.',
        'This replaces every owner. Re-run at a terminal.',
      );
    }

    if (!ctx.interactive && (!input.expectNewOwners || !input.expectNewThreshold || !input.expectExecutionTime)) {
      throw new PreconditionError(
        'Non-interactive recovery execution requires all recovery expectation flags.',
        'Pass --expect-new-owners, --expect-new-threshold, and --expect-execution-time.',
      );
    }

    await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    const recovery = ctx.qv.vault(planned.disclosure.address).recovery;
    await revalidateRecovery(ctx, planned, input);
    const { chainTxHash } = await recovery.execute(hash);
    return {
      data: { hash, vault: planned.disclosure.address, chainTxHash },
      changed: true,
      retryable: false,
      steps: [{ name: 'executeRecovery', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  recovery executed   ${r.data.hash}`),
  toJson: recoveryWriteJson,
  outputSchema: recoveryWriteSchema,
};

export const recoveryCancelCommand: CommandSpec<RecoveryWriteInput, RecoveryWriteData, RecoveryDisclosure> = {
  path: ['recovery', 'cancel'],
  describe: 'Cancel a pending recovery (any current owner)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  options: RECOVERY_EXPECT_OPTIONS,
  needs: { signer: true },
  // Deliberately zero friction: this is the defensive action, and every second
  // of hesitation favours the attacker.
  plan: (ctx, input) => planRecovery(ctx, input, 'cancel'),
  renderPlan: renderRecoveryPlan,
  planToJson: recoveryPlanJson,
  async commit(ctx, planned, input) {
    await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    const recovery = ctx.qv.vault(planned.disclosure.address).recovery;
    await revalidateRecovery(ctx, planned, input);
    const { chainTxHash } = await recovery.cancel(hash);
    return {
      data: { hash, vault: planned.disclosure.address, chainTxHash },
      changed: true,
      retryable: false,
      steps: [{ name: 'cancelRecovery', status: 'ok', chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  recovery cancelled   ${r.data.hash}`),
  toJson: recoveryWriteJson,
  outputSchema: recoveryWriteSchema,
};

export const recoveryInitiateCommand: CommandSpec<
  { vault?: string; owner: string[]; threshold: string },
  RecoveryWriteData,
  RecoveryDisclosure
> = {
  path: ['recovery', 'initiate'],
  describe: 'Initiate a recovery (guardians only)',
  args: [{ name: 'vault', description: 'vault alias or address', required: true }],
  options: [
    { flags: '--owner <address...>', description: 'new owner (repeat for each)' },
    { flags: '--threshold <n>', description: 'new threshold' },
  ],
  needs: { signer: true },

  plan(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const owners = (Array.isArray(input.owner) ? input.owner : input.owner ? [input.owner] : []).map(
      (owner) => {
        const inspected = inspectAddress(owner);
        if (!inspected.valid) throw new UsageError(`Not a usable Quai owner address: ${owner}`);
        return owner;
      },
    );
    if (!owners.length) throw new UsageError('At least one --owner is required.');
    if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) {
      throw new UsageError('Duplicate replacement owner addresses.');
    }
    const threshold = Number(input.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new UsageError(`--threshold must be between 1 and ${owners.length}.`);
    }
    if (ctx.policy && (ctx.flags.yes || !ctx.interactive) && !ctx.policy.allowRecoveryActions.includes('initiate')) {
      throw new PreconditionError('Recovery initiation is not permitted by policy.');
    }
    return Promise.resolve({
      disclosure: { address, request: null, action: 'initiate' },
      summary: `initiate recovery to ${threshold} of ${owners.length}`,
    });
  },
  planToJson: (planned) => ({
    action: 'initiate',
    vault: planned.disclosure.address,
    summary: planned.summary,
  }),

  renderPlan(planned, io) {
    io.out('');
    io.out(io.paint(span('About to INITIATE a recovery', 'danger')));
    io.out('  This starts the clock on replacing every owner of the vault.');
  },

  async commit(ctx, planned, input) {
    await ctx.requireSigner();
    const owners = Array.isArray(input.owner) ? input.owner : [input.owner];
    const result = await ctx.qv
      .vault(planned.disclosure.address)
      .recovery.initiate({ newOwners: owners, newThreshold: Number(input.threshold) });
    return {
      data: {
        hash: result.recoveryHash,
        vault: planned.disclosure.address,
        chainTxHash: result.chainTxHash,
      },
      changed: true,
      retryable: false,
      steps: [{ name: 'initiateRecovery', status: 'ok', chainTxHash: result.chainTxHash }],
    };
  },
  render: (r, io) => io.out(`  recovery initiated   ${r.data.hash}`),
  toJson: recoveryWriteJson,
  outputSchema: recoveryWriteSchema,
};

function recoveryDirectCommand(
  action: 'unapprove' | 'expire',
): CommandSpec<RecoveryWriteInput, RecoveryWriteData, RecoveryDisclosure> {
  const sdkAction = action === 'unapprove' ? 'revokeApproval' : 'expire';
  return {
    path: ['recovery', action],
    describe: action === 'unapprove' ? 'Withdraw your guardian recovery approval' : 'Clean up an expired recovery',
    args: [
      { name: 'vault', description: 'vault alias or address', required: true },
      { name: 'hash', description: 'recovery hash', required: true },
    ],
    options: RECOVERY_EXPECT_OPTIONS,
    needs: { signer: true },
    plan: (ctx, input) => planRecovery(ctx, input, action),
    renderPlan: renderRecoveryPlan,
    planToJson: recoveryPlanJson,
    async commit(ctx, planned, input) {
      await ctx.requireSigner();
      const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
      const recovery = ctx.qv.vault(planned.disclosure.address).recovery;
      await revalidateRecovery(ctx, planned, input);
      const result = action === 'unapprove'
        ? await recovery.revokeApproval(hash)
        : await recovery.expire(hash);
      return {
        data: { hash, vault: planned.disclosure.address, chainTxHash: result.chainTxHash },
        changed: true,
        retryable: false,
        steps: [{ name: sdkAction, status: 'ok', chainTxHash: result.chainTxHash }],
      };
    },
    render: (result, io) => io.out(`  recovery ${action}d   ${result.data.hash}`),
    toJson: recoveryWriteJson,
    outputSchema: recoveryWriteSchema,
  };
}

export const recoveryUnapproveCommand = recoveryDirectCommand('unapprove');
export const recoveryExpireCommand = recoveryDirectCommand('expire');

export const RECOVERY_COMMANDS = [
  recoveryStatusCommand,
  recoveryHistoryCommand,
  recoveryApproveCommand,
  recoveryExecuteCommand,
  recoveryCancelCommand,
  recoveryInitiateCommand,
  recoveryUnapproveCommand,
  recoveryExpireCommand,
] as CommandSpec[];
