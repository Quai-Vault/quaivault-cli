import { describe, expect, it } from 'vitest';
import { keccak256 } from 'quais';
import { ExitCode } from '../../src/cli/exit.js';
import { confirm, matchesTyped } from '../../src/cli/confirm.js';
import { checkPolicy, type Policy } from '../../src/context/policy.js';
import {
  txApproveCommand,
  txCancelCommand,
  txExecuteCommand,
  outcomeExit,
} from '../../src/commands/tx-write.js';
import {
  ADDR,
  batchOfBuiltins,
  batchOfTwo,
  batchWithDelegatecall,
  createFakeClient,
  createFakeContext,
  fakeTx,
  unreadableBatch,
} from '../fake-client.js';

/** Assert against message + remediation: the actionable half is the remediation. */
async function rejectsWith(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p;
  } catch (err) {
    const e = err as { message?: string; remediation?: string };
    expect(`${e.message ?? ''}\n${e.remediation ?? ''}`).toMatch(re);
    return;
  }
  throw new Error(`expected a rejection matching ${String(re)}`);
}
import type { VaultTransaction } from '@quaivault/sdk';
import { mainnet } from '@quaivault/sdk';

const HASH = fakeTx().hash;
const abort = new AbortController().signal;

function ctxWith(tx: VaultTransaction, over: Parameters<typeof createFakeContext>[0] = {}) {
  return createFakeContext({
    client: createFakeClient({ vaults: { [ADDR.vault]: { pending: [tx] } } }),
    identity: ADDR.alice,
    ...over,
  });
}

const permissivePolicy: Policy = {
  allowTo: [],
  denyKinds: [],
  denyDelegatecall: true,
  requireAbiSource: ['builtin'],
  allowRecoveryActions: [],
};

describe('execute outcomes map to distinct exit codes', () => {
  it('never lets a failed vault call look like success', () => {
    // The chain transaction succeeded; the vault call did not.
    expect(outcomeExit('executed')).toBe(ExitCode.Ok);
    expect(outcomeExit('failed')).toBe(ExitCode.Failure);
    expect(outcomeExit('failed')).not.toBe(ExitCode.Ok);
  });

  it('distinguishes not-executed from both success and failure', () => {
    // `qv tx execute && deploy.sh` must not proceed on either of these.
    expect(outcomeExit('approved_only')).toBe(ExitCode.NotExecuted);
    expect(outcomeExit('timelock_started')).toBe(ExitCode.NotExecuted);
    expect(outcomeExit('approved_only')).not.toBe(ExitCode.Ok);
  });

  it('covers every outcome the SDK can return', () => {
    // If the SDK widens ExecuteOutcome, this throws rather than failing open.
    for (const o of ['executed', 'failed', 'timelock_started', 'approved_only'] as const) {
      expect(() => outcomeExit(o)).not.toThrow();
    }
  });
});

describe('assertion flags bind an agent to the bytes, not to prose', () => {
  const tx = fakeTx({ data: '0xa9059cbb', value: 100n, to: ADDR.alice });

  it('refuses when the recipient does not match', async () => {
    const ctx = ctxWith(tx);
    await expect(
      txApproveCommand.plan!(ctx, { hash: HASH, expectTo: ADDR.carol }, abort),
    ).rejects.toThrow(/Recipient does not match/);
  });

  it('refuses when the value does not match', async () => {
    const ctx = ctxWith(tx);
    await expect(
      txApproveCommand.plan!(ctx, { hash: HASH, expectValue: '999' }, abort),
    ).rejects.toThrow(/Value does not match/);
  });

  it('refuses when the calldata hash does not match', async () => {
    const ctx = ctxWith(tx);
    await expect(
      txApproveCommand.plan!(ctx, { hash: HASH, expectDataHash: keccak256('0xdeadbeef') }, abort),
    ).rejects.toThrow(/Calldata hash does not match/);
  });

  it('refuses when the decode provenance is weaker than demanded', async () => {
    const ctx = ctxWith(fakeTx({ data: '0xdeadbeef' }));
    await expect(
      txApproveCommand.plan!(ctx, { hash: HASH, expectAbiSource: 'builtin' }, abort),
    ).rejects.toThrow(/provenance does not match/);
  });

  it('passes when every expectation holds', async () => {
    const ctx = ctxWith(tx);
    const planned = await txApproveCommand.plan!(
      ctx,
      {
        hash: HASH,
        expectTo: ADDR.alice,
        expectValue: '100',
        expectAbiSource: 'none',
        expectDataHash: keccak256('0xa9059cbb'),
      },
      abort,
    );
    expect(planned.summary).toContain('approve');
  });
});

describe('policy bounds non-interactive signing', () => {
  it('refuses a value above the ceiling', () => {
    const violations = checkPolicy(
      { ...permissivePolicy, maxValuePerApprovalWei: 10n },
      {
        value: 11n,
        to: ADDR.alice,
        kind: 'transfer',
        isDelegatecall: false,
        abiSource: 'builtin',
        approvalsLastHour: 0,
      },
    );
    expect(violations.map((v) => v.rule)).toContain('max_value_per_approval_wei');
  });

  it('counts native value attached to contract calls and every batch effect', () => {
    const violations = checkPolicy(
      { ...permissivePolicy, maxValuePerApprovalWei: 10n },
      {
        value: 0n,
        to: ADDR.vault,
        kind: 'batched_call',
        isDelegatecall: false,
        abiSource: 'builtin',
        approvalsLastHour: 0,
        effects: [
          { to: ADDR.alice, value: 6n, kind: 'external_call' },
          { to: ADDR.bob, value: 5n, kind: 'external_call' },
        ],
      },
    );
    expect(violations.map((v) => v.rule)).toContain('max_value_per_approval_wei');
  });

  it('does not apply the approval rate limit to non-approval lifecycle writes', () => {
    const violations = checkPolicy(
      { ...permissivePolicy, maxApprovalsPerHour: 0 },
      {
        value: 0n,
        to: ADDR.alice,
        kind: 'transfer',
        isDelegatecall: false,
        abiSource: 'builtin',
        approvalsLastHour: 9,
        countTowardApprovalLimit: false,
      },
    );
    expect(violations.map((v) => v.rule)).not.toContain('max_approvals_per_hour');
  });

  it('refuses a recipient outside the allowlist', () => {
    const violations = checkPolicy(
      { ...permissivePolicy, allowTo: [ADDR.carol.toLowerCase()] },
      {
        value: 1n,
        to: ADDR.alice,
        kind: 'transfer',
        isDelegatecall: false,
        abiSource: 'builtin',
        approvalsLastHour: 0,
      },
    );
    expect(violations.map((v) => v.rule)).toContain('allow_to');
  });

  it('refuses a delegatecall and a weak decode provenance', () => {
    const violations = checkPolicy(permissivePolicy, {
      value: 1n,
      to: ADDR.alice,
      kind: 'transfer',
      isDelegatecall: true,
      abiSource: 'heuristic',
      approvalsLastHour: 0,
    });
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain('deny_delegatecall');
    expect(rules).toContain('require_abi_source');
  });

  it('applies to a --yes run', async () => {
    const ctx = ctxWith(fakeTx({ value: 10n ** 30n }), {
      flags: { yes: true },
      policy: { ...permissivePolicy, maxValuePerApprovalWei: 1n },
    });
    await expect(txApproveCommand.plan!(ctx, { hash: HASH }, abort)).rejects.toThrow(
      /Refused by policy/,
    );
  });

  it('does not bind an attended human', async () => {
    // The prompt and the disclosure bind them instead.
    const ctx = ctxWith(fakeTx({ value: 10n ** 30n }), {
      interactive: true,
      flags: { yes: false, noInput: false },
      policy: { ...permissivePolicy, maxValuePerApprovalWei: 1n },
    });
    await expect(txApproveCommand.plan!(ctx, { hash: HASH }, abort)).resolves.toBeTruthy();
  });
});

describe('confirmation gate', () => {
  it('refuses non-interactive signing when no policy file exists', async () => {
    const ctx = ctxWith(fakeTx(), { flags: { yes: true }, policy: null });
    const planned = await txApproveCommand.plan!(ctx, { hash: HASH }, abort);
    await expect(confirm(ctx, planned, txApproveCommand)).rejects.toThrow(
      /Non-interactive signing requires a policy file/,
    );
  });

  it('demands a second explicit flag for an unverified decode, even with --yes', async () => {
    const ctx = ctxWith(fakeTx({ data: '0xdeadbeef' }), {
      flags: { yes: true },
      policy: { ...permissivePolicy, requireAbiSource: ['builtin', 'none'] },
    });
    const planned = await txApproveCommand.plan!(ctx, { hash: HASH }, abort);
    await rejectsWith(confirm(ctx, planned, txApproveCommand), /--i-understand-unverified/);
  });

  it('accepts an unverified decode once the second flag is given', async () => {
    const ctx = ctxWith(fakeTx({ data: '0xdeadbeef' }), {
      flags: { yes: true, iUnderstandUnverified: true },
      policy: { ...permissivePolicy, requireAbiSource: ['builtin', 'none'] },
    });
    const planned = await txApproveCommand.plan!(ctx, { hash: HASH }, abort);
    await expect(confirm(ctx, planned, txApproveCommand)).resolves.toBe(true);
  });

  it('fails closed with no TTY rather than hanging', async () => {
    const ctx = ctxWith(fakeTx(), {
      flags: { yes: false },
      interactive: false,
      policy: permissivePolicy,
    });
    const planned = await txApproveCommand.plan!(ctx, { hash: HASH }, abort);
    await expect(confirm(ctx, planned, txApproveCommand)).rejects.toThrow(/no terminal/);
  });
});

describe('idempotency', () => {
  it('treats a re-approval as a no-op, exit 0, changed false', async () => {
    // An agent SIGKILLed after broadcast retries; this is the designed
    // guarantee that makes that safe.
    const tx = fakeTx({ approvals: [{ owner: ADDR.alice, active: true }], approvalCount: 1 });
    const ctx = ctxWith(tx, { identity: ADDR.alice });
    const planned = await txApproveCommand.plan!(ctx, { hash: HASH }, abort);
    const result = await txApproveCommand.commit!(ctx, planned, { hash: HASH }, abort);
    expect(result.changed).toBe(false);
    expect(result.exitCode ?? ExitCode.Ok).toBe(ExitCode.Ok);
    expect(result.steps?.[0]?.status).toBe('skipped');
  });
});

describe('cancel does not silently escalate into a new proposal', () => {
  it('refuses proposer-cancel past quorum and names the other command', async () => {
    const tx = fakeTx({ approvedAt: 1_780_000_000, approvalCount: 2 });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    const planned = await txCancelCommand.plan!(ctx, { hash: HASH }, abort);
    await rejectsWith(
      txCancelCommand.commit!(ctx, planned, { hash: HASH }, abort),
      /cancel-by-consensus/,
    );
  });
});

describe('dry run', () => {
  it('produces a full disclosure without signing anything', async () => {
    const ctx = ctxWith(fakeTx());
    const planned = await txExecuteCommand.plan!(ctx, { hash: HASH }, abort);
    expect(planned.disclosure.tx.hash).toBe(HASH);
    expect(planned.dataHash).toBeTruthy();
    // plan() is a pure read: it returns a disclosure and touches no signer.
    expect(ctx.io.stdout).toHaveLength(0);
  });
});

describe('the batch gate — the only delegatecall detection that exists', () => {
  // The vault's transaction struct has no operation field, so a top-level
  // vault transaction is structurally always a CALL. Every one of these goes
  // through the MultiSend payload, because that is the only place an
  // operation byte lives (plan §7, src/abi/batch.ts).

  it('refuses an inner delegatecall non-interactively, even under a permissive policy', async () => {
    const tx = fakeTx({ data: batchWithDelegatecall(), kind: 'batched_call', to: mainnet.contracts.multiSendCallOnly! });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    await rejectsWith(
      txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort),
      /deny_delegatecall/,
    );
  });

  it('refuses a batch whose payload cannot be accounted for', async () => {
    // Fail closed: bytes we cannot read might be a delegatecall, and a
    // disclosure that showed one sub-call for a blob the chain reads
    // differently would be worse than no disclosure at all.
    const tx = fakeTx({ data: unreadableBatch(), kind: 'batched_call', to: mainnet.contracts.multiSendCallOnly! });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    await rejectsWith(
      txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort),
      /deny_delegatecall|require_abi_source/,
    );
  });

  it('does not let a builtin outer decode launder weak sub-calls', async () => {
    // `multiSend(bytes)` always decodes builtin, so before recursion this
    // satisfied `require_abi_source = ["builtin"]` no matter what was inside.
    // An ERC-20 transfer is the realistic version: it decodes `heuristic`,
    // because the SDK is matching a selector against an address it cannot
    // confirm is a token at all.
    const tx = fakeTx({ data: batchOfTwo(), kind: 'batched_call', to: mainnet.contracts.multiSendCallOnly! });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    await rejectsWith(
      txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort),
      /require_abi_source/,
    );
  });

  it('allows a batch whose every sub-call the SDK vouches for', async () => {
    const tx = fakeTx({ data: batchOfBuiltins(), kind: 'batched_call', to: mainnet.contracts.multiSendCallOnly! });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    const planned = await txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort);
    expect(planned.disclosure.unverified).toBe(false);
  });

  it('marks a delegatecall batch unverified so the second flag is required', async () => {
    // §7's --yes gate is mechanical: an inner delegatecall trips it even
    // though the outer operation is 0 — which it always is.
    const tx = fakeTx({ data: batchWithDelegatecall(), kind: 'batched_call', to: mainnet.contracts.multiSendCallOnly! });
    const ctx = ctxWith(tx, { policy: null, flags: { yes: true } });
    const planned = await txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort);
    expect(planned.disclosure.unverified).toBe(true);
  });

  it('leaves a plain non-batch call alone', async () => {
    const tx = fakeTx({ abiSource: 'builtin' });
    const ctx = ctxWith(tx, { policy: permissivePolicy, flags: { yes: true } });
    const planned = await txApproveCommand.plan!(ctx, { vault: ADDR.vault, hash: HASH }, abort);
    expect(planned.disclosure.unverified).toBe(false);
    expect(planned.disclosure.batch).toBeNull();
  });
});

describe('typed confirmations (plan §3.6, §8 R8)', () => {
  const ADDRESS = '0x0006506bDE7140b85DED58a40D7444F84cde4821';

  it('accepts any EIP-55 spelling of the same address', () => {
    // Found with a real key: `qv key import` printed the checksummed form and
    // `qv key rm` demanded the lowercase one, refusing the address it had
    // just shown the user. Casing is a checksum, not identity.
    for (const given of [ADDRESS, ADDRESS.toLowerCase(), ADDRESS.toUpperCase().replace('0X', '0x')]) {
      expect(matchesTyped(given, ADDRESS.toLowerCase(), { foldCase: true }), given).toBe(true);
    }
  });

  it('still refuses a different address', () => {
    expect(matchesTyped('0x00deadbeefdeadbeefdeadbeefdeadbeefdeadbe', ADDRESS, { foldCase: true })).toBe(
      false,
    );
    // One character off must not pass.
    expect(matchesTyped(ADDRESS.slice(0, -1) + '2', ADDRESS, { foldCase: true })).toBe(false);
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(matchesTyped(`  ${ADDRESS}  `, ADDRESS, { foldCase: true })).toBe(true);
  });

  it('keeps alias confirmation case-sensitive', () => {
    // `qv recovery execute` types a vault alias, and two aliases differing
    // only by case can both exist — folding would make the confirmation
    // ambiguous about which vault is being recovered.
    expect(matchesTyped('treasury', 'treasury')).toBe(true);
    expect(matchesTyped('TREASURY', 'treasury')).toBe(false);
  });

  it('refuses an empty answer under either mode', () => {
    expect(matchesTyped('', ADDRESS, { foldCase: true })).toBe(false);
    expect(matchesTyped('   ', 'treasury')).toBe(false);
  });
});
