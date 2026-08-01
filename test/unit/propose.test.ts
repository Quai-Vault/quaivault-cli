import { describe, expect, it } from 'vitest';
import { MAX_EXECUTION_DELAY, minimumExpiration } from '@quaivault/sdk';
import { parseDuration, proposeTransferCommand } from '../../src/commands/propose.js';
import { ADDR, createFakeClient, createFakeContext, fakeVaultInfo } from '../fake-client.js';

const abort = new AbortController().signal;
const NOW = 1_800_000_000;

/**
 * Expiration timing (plan Phase 4, §7's single-source rule, Appendix A).
 *
 * The observed failure this guards against was two effective-delay formulas
 * in two files — `max` in one, `+` in the other — against a contract that
 * uses `max`, plus a UI capping input at 365 days against a 30-day contract
 * maximum. Both are arithmetic nobody notices is wrong until a proposal
 * reverts or expires before it can execute.
 */
function ctxWith(minExecutionDelay: number) {
  return createFakeContext({
    client: createFakeClient({
      vaults: { [ADDR.vault]: { info: fakeVaultInfo({ minExecutionDelay }) } },
    }),
    identity: ADDR.alice,
    now: NOW,
  });
}

async function planTransfer(minExecutionDelay: number, input: Record<string, unknown>) {
  const ctx = ctxWith(minExecutionDelay);
  return proposeTransferCommand.plan!(
    ctx,
    { vault: ADDR.vault, to: ADDR.carol, amount: '1', ...input },
    abort,
  );
}

describe('parseDuration', () => {
  it('reads the units a human actually types', () => {
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('30m')).toBe(1800);
    expect(parseDuration('24h')).toBe(86_400);
    expect(parseDuration('7d')).toBe(604_800);
    expect(parseDuration('600')).toBe(600);
  });

  it('refuses input it cannot read rather than guessing', () => {
    for (const bad of ['', 'soon', '7 days', '-1', '1w', '3.5h']) {
      expect(() => parseDuration(bad), bad).toThrow();
    }
  });
});

describe('the effective delay is max(vaultFloor, userDelay), never the sum', () => {
  it('uses the vault floor when it is the larger', async () => {
    // Floor 24h, user asks for 1h. Effective is 24h. Under a `+` formula it
    // would be 25h and a 24h-and-a-bit expiry would be wrongly rejected.
    const planned = await planTransfer(86_400, { executionDelay: '1h', expiration: '25h' });
    expect(planned.disclosure.detail.join('\n')).toBeTruthy();
  });

  it('uses the user delay when it is the larger', async () => {
    const planned = await planTransfer(3600, { executionDelay: '24h', expiration: '30h' });
    expect(planned.disclosure.detail.join('\n')).toBeTruthy();
  });

  it('rejects an expiry inside the effective timelock', async () => {
    // 24h floor, expiry in 2h: the transaction would expire 22 hours before
    // it could ever execute.
    await expect(planTransfer(86_400, { expiration: '2h' })).rejects.toThrow(
      /before the transaction could ever execute/,
    );
  });

  it('rejects an expiry that clears the timelock but not the mining margin', async () => {
    // The gap this closes. The contract rejects `expiration <= timestamp +
    // effectiveDelay`, so an expiry one second past the floor is legal on
    // paper and lost the moment the proposal waits a block to be mined. The
    // old local computation used no margin while the error message told the
    // user to leave one.
    const floor = 3600;
    const barelyPast = minimumExpiration(floor, 0, NOW) + 1;
    expect(barelyPast).toBeLessThan(minimumExpiration(floor, undefined, NOW));
    await expect(
      planTransfer(floor, { expiration: String(barelyPast) }),
    ).rejects.toThrow(/before the transaction could ever execute/);
  });

  it('accepts an expiry past the margin', async () => {
    const floor = 3600;
    const safe = minimumExpiration(floor, undefined, NOW) + 60;
    const planned = await planTransfer(floor, { expiration: String(safe) });
    expect(planned.disclosure.action).toBeTruthy();
  });
});

describe('the timelock cap comes from the contract, not from a guess', () => {
  it('refuses a delay above MAX_EXECUTION_DELAY', async () => {
    // Appendix A: a UI capped input at 365 days against a 30-day contract
    // maximum. The constant is read from the SDK so the two cannot drift.
    const tooLong = `${MAX_EXECUTION_DELAY + 1}`;
    await expect(planTransfer(0, { executionDelay: tooLong })).rejects.toThrow(
      /exceeds the contract maximum/,
    );
  });

  it('accepts a delay exactly at the maximum', async () => {
    const planned = await planTransfer(0, { executionDelay: `${MAX_EXECUTION_DELAY}` });
    expect(planned.disclosure.action).toBeTruthy();
  });
});
