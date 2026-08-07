import type {
  Affordance,
  RecoveryAffordance,
  RecoveryRequest,
  VaultTransaction,
} from '@quaivault/sdk';
import { mapPooled } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { cacheKey } from '../store/index.js';
import { UsageError } from '../context/context.js';
import { span } from '../format/tone.js';
import {
  abiSourceBadge,
  formatApproximateAge,
  formatDuration,
  safeText,
} from '../format/index.js';
import { txToJson } from '../render/transaction.js';

type Bucket = 'needsYou' | 'readyToExecute' | 'waitingOnOthers' | 'expiringSoon';

interface InboxItem {
  vault: string;
  vaultLabel: string;
  tx: VaultTransaction;
  bucket: Bucket;
  affordances: Affordance[];
}

/**
 * A pending recovery, which is not a transaction and does not belong in the
 * transaction buckets.
 *
 * It matters to both roles and for opposite reasons: to a guardian it is the
 * thing they exist to act on, and to an owner it is someone attempting to
 * replace the entire owner set. Either way it outranks anything else in here,
 * so it is a separate list rendered first rather than a fifth bucket.
 */
interface RecoveryItem {
  vault: string;
  vaultLabel: string;
  recovery: RecoveryRequest;
  affordances: RecoveryAffordance[];
  /** True when this identity can approve or execute it right now. */
  actionable: boolean;
}

interface InboxData {
  identity: string;
  items: InboxItem[];
  recoveries: RecoveryItem[];
  vaultCount: number;
  discoveredVaultCount: number;
  truncated: boolean;
  chainHead?: number;
  degraded: boolean;
  countOnly: boolean;
  actionableCount: number;
}

const EXPIRING_SOON_SECONDS = 24 * 3600;

/**
 * Cross-vault, urgency-ordered, and **keyless** — `affordances()` takes a plain
 * address, so the most valuable command in the product needs no key at all.
 *
 * Grouped by what you can do about it rather than by vault: "waiting on others"
 * matters as much as "needs you", because it is how a proposer learns their
 * transaction is alive and who is holding it up.
 */
export const inboxCommand: CommandSpec<{ count?: boolean; limit?: string }, InboxData> = {
  path: ['inbox'],
  // Deliberately not vault-scoped: inbox spans every vault the identity
  // touches, so a change to any one of them makes the whole view wrong.
  key: (input) => cacheKey(['inbox'], input.limit),
  // `recoveries` matters now that pending recoveries are part of this view —
  // without it a recovery could land and the cached inbox would not notice.
  invalidatedBy: ['transactions', 'confirmations', 'owners', 'recoveries'],
  describe: 'What is waiting on you, across every vault',
  options: [
    { flags: '--count', description: 'print a bare integer for a shell prompt', defaultValue: false },
    { flags: '--limit <n>', description: 'max vaults to scan', defaultValue: '200' },
  ],
  needs: { identity: true, indexer: 'required' },

  async run(ctx, input) {
    const identity = ctx.identity();
    if (!identity) throw new UsageError('No identity set.');
    const limit = Number(input.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new UsageError('--limit must be a whole number from 1 to 200.');
    }

    const [owned, guardian, health] = await Promise.all([
      ctx.qv.vaults.forOwner(identity),
      ctx.qv.vaults.forGuardian(identity),
      ctx.qv.indexerHealth().catch(() => null),
    ]);
    const discovered = [...new Set([...owned, ...guardian].map((a) => a))];
    const all = discovered.slice(0, limit);

    const items: InboxItem[] = [];
    const recoveries: RecoveryItem[] = [];
    const now = ctx.now();

    await mapPooled(all, 6, async (address) => {
        const vault = ctx.qv.vault(address);

        // Read before the early return below. A guardian-only identity has no
        // pending transactions on a vault it guards, and the previous shape
        // returned at that point — so the one thing a guardian is here for
        // never reached the inbox at all.
        const pendingRecoveries = await vault.recovery.pending();
        if (pendingRecoveries.length) {
          const sets = await Promise.all(
            pendingRecoveries.map((r) => vault.recovery.affordances(r.hash, identity)),
          );
          pendingRecoveries.forEach((recovery, i) => {
            const affordances = sets[i] ?? [];
            recoveries.push({
              vault: address,
              vaultLabel: labelFor(ctx.config.aliases, address),
              recovery,
              affordances,
              actionable: affordances.some(
                (a) => a.allowed && (a.action === 'approve' || a.action === 'execute'),
              ),
            });
          });
        }

        const pending: VaultTransaction[] = await vault.pendingTransactions({ limit: 50 });
        if (pending.length === 0) return;
        // One batched affordance pass per transaction, keyless.
        const affordanceSets = await Promise.all(
          pending.map((tx) => vault.affordances(tx.hash, identity)),
        );
        pending.forEach((tx, i) => {
          const affordances = affordanceSets[i] ?? [];
          const can = (a: string): boolean =>
            affordances.some((x) => x.action === a && x.allowed);
          const alreadyApproved = tx.approvals.some(
            (a) => a.active && a.owner.toLowerCase() === identity.toLowerCase(),
          );
          let bucket: Bucket;
          if (can('execute') || can('approveAndExecute')) bucket = 'readyToExecute';
          else if (can('approve') && !alreadyApproved) bucket = 'needsYou';
          else bucket = 'waitingOnOthers';
          if (
            tx.expiration > 0 &&
            tx.expiration - now < EXPIRING_SOON_SECONDS &&
            tx.expiration > now
          ) {
            bucket = bucket === 'waitingOnOthers' ? 'expiringSoon' : bucket;
          }
          items.push({
            vault: address,
            vaultLabel: labelFor(ctx.config.aliases, address),
            tx,
            bucket,
            affordances,
          });
        });
      });

    const order: Bucket[] = ['needsYou', 'readyToExecute', 'expiringSoon', 'waitingOnOthers'];
    items.sort((a, b) => {
      const d = order.indexOf(a.bucket) - order.indexOf(b.bucket);
      if (d !== 0) return d;
      return (b.tx.proposedAtBlock ?? 0) - (a.tx.proposedAtBlock ?? 0);
    });

    // Actionable first, then soonest executable — a guardian's queue.
    recoveries.sort((a, b) => {
      if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
      return (a.recovery.executionTime || 0) - (b.recovery.executionTime || 0);
    });

    return {
      data: {
        identity,
        items,
        recoveries,
        vaultCount: all.length,
        discoveredVaultCount: discovered.length,
        truncated: discovered.length > all.length,
        chainHead: health?.chainHead,
        degraded: health?.available === false,
        countOnly: input.count === true,
        actionableCount:
          items.filter((item) => item.bucket === 'needsYou' || item.bucket === 'readyToExecute').length +
          recoveries.filter((recovery) => recovery.actionable).length,
      },
      changed: false,
      warnings:
        discovered.length > all.length
          ? [`Scanned ${all.length} of ${discovered.length} vaults; increase --limit for a complete inbox.`]
          : undefined,
    };
  },

  render(result, io, ctx) {
    const { identity, items, recoveries, vaultCount, chainHead, degraded } = result.data;

    if (result.data.countOnly) {
      io.out(String(result.data.actionableCount));
      return;
    }

    if (ctx.flags.quiet) return;

    const contact = ctx.contactName(identity);
    io.out(
      `acting as ${identity}${contact ? ` (${safeText(contact, 40)})` : ''}    ${vaultCount} vault${vaultCount === 1 ? '' : 's'}`,
    );
    if (degraded) {
      io.err('warning: indexer unavailable — this inbox is incomplete, not empty.');
    }

    // First, and loudly. A recovery replaces the whole owner set: for a
    // guardian it is the job, for an owner it is an alarm.
    if (recoveries.length) {
      io.out('');
      io.out(io.paint(span(`RECOVERY PENDING (${recoveries.length})`, 'danger')));
      for (const item of recoveries) {
        const r = item.recovery;
        const when =
          r.executionTime > ctx.now()
            ? `executable in ${formatDuration(r.executionTime - ctx.now())}`
            : 'executable now';
        io.out(
          `  ${item.vaultLabel.padEnd(12)} ${r.hash.slice(2, 10)}  ${r.approvalCount}/${r.requiredThreshold}  ` +
            `${`→ ${r.newOwners.length} new owner${r.newOwners.length === 1 ? '' : 's'}, threshold ${r.newThreshold}`.padEnd(44)} ` +
            `${io.paint(span(when, r.executionTime > ctx.now() ? 'warn' : 'danger'))}` +
            `${item.actionable ? io.paint(span('  needs you', 'warn')) : ''}`,
        );
      }
      io.out('');
      io.err(`  qv recovery status ${recoveries[0]!.vaultLabel}     detail`);
    }

    if (items.length === 0) {
      if (!recoveries.length) {
        io.out('');
        io.out('  Nothing waiting on you.');
      }
      return;
    }

    const titles: Record<Bucket, string> = {
      needsYou: 'NEEDS YOU',
      readyToExecute: 'READY TO EXECUTE',
      expiringSoon: 'EXPIRING SOON',
      waitingOnOthers: 'WAITING ON OTHERS',
    };
    const tones = { needsYou: 'warn', readyToExecute: 'ok', expiringSoon: 'danger', waitingOnOthers: 'muted' } as const;

    for (const bucket of ['needsYou', 'readyToExecute', 'expiringSoon', 'waitingOnOthers'] as Bucket[]) {
      const group = items.filter((i) => i.bucket === bucket);
      if (!group.length) continue;
      io.out('');
      io.out(io.paint(span(`${titles[bucket]} (${group.length})`, tones[bucket])));
      for (const item of group) {
        const age = formatApproximateAge(item.tx.proposedAtBlock, chainHead) ?? '';
        const expiry =
          item.tx.expiration > 0
            ? ` · expires ${formatDuration(item.tx.expiration - ctx.now())}`
            : '';
        const badge =
          item.tx.abiSource === 'builtin' ? '' : ` ${io.paint(abiSourceBadge(item.tx.abiSource))}`;
        io.out(
          `  ${item.vaultLabel.padEnd(12)} ${item.tx.hash.slice(2, 10)}  ${String(item.tx.approvalCount)}/${item.tx.threshold}  ${safeText(item.tx.summary, 44).padEnd(44)} ${io.paint(span(age + expiry, 'muted'))}${badge}`,
        );
      }
    }
    io.out('');
    const first = items[0]!;
    io.err(`  qv tx show ${first.vaultLabel} ${first.tx.hash.slice(2, 10)}     detail`);
  },

  toJson(result) {
    if (result.data.countOnly) return { count: result.data.actionableCount };
    return {
      identity: result.data.identity,
      vaultCount: result.data.vaultCount,
      discoveredVaultCount: result.data.discoveredVaultCount,
      truncated: result.data.truncated,
      degraded: result.data.degraded,
      counts: {
        needsYou: result.data.items.filter((i) => i.bucket === 'needsYou').length,
        readyToExecute: result.data.items.filter((i) => i.bucket === 'readyToExecute').length,
        expiringSoon: result.data.items.filter((i) => i.bucket === 'expiringSoon').length,
        waitingOnOthers: result.data.items.filter((i) => i.bucket === 'waitingOnOthers').length,
        recoveriesPending: result.data.recoveries.length,
        recoveriesNeedingYou: result.data.recoveries.filter((r) => r.actionable).length,
      },
      recoveries: result.data.recoveries.map((r) => ({
        vault: r.vault,
        hash: r.recovery.hash,
        newOwners: r.recovery.newOwners,
        newThreshold: r.recovery.newThreshold,
        approvalCount: r.recovery.approvalCount,
        requiredThreshold: r.recovery.requiredThreshold,
        executionTime: r.recovery.executionTime,
        expiration: r.recovery.expiration,
        actionable: r.actionable,
        affordances: r.affordances.map((a) => ({
          action: a.action,
          allowed: a.allowed,
          reason: a.reason,
        })),
      })),
      items: result.data.items.map((i) => ({
        vault: i.vault,
        bucket: i.bucket,
        transaction: txToJson(i.tx, result.data.chainHead),
        affordances: i.affordances.map((a) => ({
          action: a.action,
          allowed: a.allowed,
          reason: a.reason,
          availableAt: a.availableAt ?? null,
        })),
      })),
    } as never;
  },

  outputSchema: {
    type: 'object',
    properties: {
      identity: { type: 'string' },
      vaultCount: { type: 'integer' },
      discoveredVaultCount: { type: 'integer' },
      truncated: { type: 'boolean' },
      degraded: { type: 'boolean' },
      counts: { type: 'object' },
      items: { type: 'array' },
      recoveries: { type: 'array' },
    },
  },
};

function labelFor(aliases: Record<string, string>, address: string): string {
  const found = Object.entries(aliases).find(([, v]) => v.toLowerCase() === address.toLowerCase());
  return found ? found[0] : `${address.slice(0, 8)}…`;
}

/** `qv inbox --count` prints a bare integer for a prompt or status line. */
export const inboxCountCommand: CommandSpec<Record<string, never>, { count: number }> = {
  path: ['inbox-count'],
  describe: 'Bare count of transactions needing you (for shell prompts)',
  needs: { identity: true, indexer: 'required' },

  async run(ctx, _input, signal) {
    const result = await inboxCommand.run!(ctx, { limit: '200' }, signal);
    const count =
      result.data.items.filter((i) => i.bucket === 'needsYou' || i.bucket === 'readyToExecute')
        .length +
      // A guardian's only actionable item is a recovery. Leaving it out meant
      // a prompt counter read zero while a recovery sat waiting on them.
      result.data.recoveries.filter((r) => r.actionable).length;
    return { data: { count }, changed: false, warnings: result.warnings };
  },
  render: (result, io) => io.out(String(result.data.count)),
  toJson: (r) => ({ count: r.data.count }),
  outputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
};
