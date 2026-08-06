import { describe, expect, it } from 'vitest';
import { inboxCommand, inboxCountCommand } from '../../src/commands/inbox.js';
import { ADDR, createFakeClient, createFakeContext } from '../fake-client.js';

const abort = new AbortController().signal;

/**
 * The guardian case.
 *
 * A guardian may own nothing. On a vault it only guards it has no pending
 * transactions, and the inbox used to `return` at exactly that point — so the
 * one thing a guardian exists to act on never appeared, and `--count`, which a
 * shell prompt reads, said zero while a recovery sat waiting.
 */
describe('qv inbox surfaces pending recoveries', () => {
  const guardianOnly = (over: Record<string, unknown> = {}) =>
    createFakeContext({
      client: createFakeClient({
        forOwner: [],
        forGuardian: [ADDR.vault],
        vaults: {
          [ADDR.vault.toLowerCase()]: {
            pending: [],
            hasPendingRecovery: true,
            recoveryAffordances: [{ action: 'approve', allowed: true, reason: '' }],
            ...over,
          },
        },
      }),
      identity: ADDR.alice,
    });

  it('shows a recovery on a vault with no pending transactions at all', async () => {
    const result = await inboxCommand.run!(guardianOnly(), { limit: '25' }, abort);
    expect(result.data.items).toHaveLength(0);
    expect(result.data.recoveries).toHaveLength(1);
    expect(result.data.recoveries[0]?.vault.toLowerCase()).toBe(ADDR.vault.toLowerCase());
  });

  it('marks it actionable when this identity may approve or execute', async () => {
    const result = await inboxCommand.run!(guardianOnly(), { limit: '25' }, abort);
    expect(result.data.recoveries[0]?.actionable).toBe(true);
  });

  it('does not mark it actionable when every action is blocked', async () => {
    const ctx = guardianOnly({
      recoveryAffordances: [{ action: 'approve', allowed: false, reason: 'already approved' }],
    });
    const result = await inboxCommand.run!(ctx, { limit: '25' }, abort);
    expect(result.data.recoveries).toHaveLength(1);
    expect(result.data.recoveries[0]?.actionable).toBe(false);
  });

  it('counts an actionable recovery, so a prompt counter is not silently zero', async () => {
    const result = await inboxCountCommand.run!(guardianOnly(), {}, abort);
    expect(result.data.count).toBe(1);
  });

  it('does not count one this identity cannot act on', async () => {
    const ctx = guardianOnly({
      recoveryAffordances: [{ action: 'execute', allowed: false, reason: 'timelock' }],
    });
    const result = await inboxCountCommand.run!(ctx, {}, abort);
    expect(result.data.count).toBe(0);
  });

  it('reports recoveries in --json, including the counts an agent branches on', async () => {
    const result = await inboxCommand.run!(guardianOnly(), { limit: '25' }, abort);
    const json = inboxCommand.toJson(result, guardianOnly());
    expect(json).toMatchObject({
      counts: { recoveriesPending: 1, recoveriesNeedingYou: 1 },
      // The new owner set is the whole point of disclosing a recovery.
      recoveries: [{ actionable: true, newOwners: [ADDR.carol] }],
    });
  });

  it('leaves the transaction buckets alone when there is no recovery', async () => {
    const ctx = createFakeContext({
      client: createFakeClient({
        forOwner: [ADDR.vault],
        forGuardian: [],
        vaults: { [ADDR.vault.toLowerCase()]: { hasPendingRecovery: false } },
      }),
      identity: ADDR.alice,
    });
    const result = await inboxCommand.run!(ctx, { limit: '25' }, abort);
    expect(result.data.recoveries).toEqual([]);
  });
});
