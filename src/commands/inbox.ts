import type { Affordance, VaultTransaction } from '@quaivault/sdk';
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

interface InboxData {
  identity: string;
  items: InboxItem[];
  vaultCount: number;
  chainHead?: number;
  degraded: boolean;
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
  invalidatedBy: ['transactions', 'confirmations', 'owners'],
  describe: 'What is waiting on you, across every vault',
  options: [
    { flags: '--count', description: 'print a bare integer for a shell prompt', defaultValue: false },
    { flags: '--limit <n>', description: 'max vaults to scan', defaultValue: '25' },
  ],
  needs: { identity: true, indexer: 'required' },

  async run(ctx, input) {
    const identity = ctx.identity();
    if (!identity) throw new UsageError('No identity set.');
    const limit = Number(input.limit ?? 25);

    const [owned, guardian, health] = await Promise.all([
      ctx.qv.vaults.forOwner(identity).catch(() => [] as string[]),
      ctx.qv.vaults.forGuardian(identity).catch(() => [] as string[]),
      ctx.qv.indexerHealth().catch(() => null),
    ]);
    const all = [...new Set([...owned, ...guardian].map((a) => a))].slice(0, limit);

    const items: InboxItem[] = [];
    const now = ctx.now();

    await Promise.all(
      all.map(async (address) => {
        const vault = ctx.qv.vault(address);
        let pending: VaultTransaction[] = [];
        try {
          pending = await vault.pendingTransactions({ limit: 50 });
        } catch {
          return;
        }
        if (pending.length === 0) return;
        // One batched affordance pass per transaction, keyless.
        const affordanceSets = await Promise.all(
          pending.map((tx) => vault.affordances(tx.hash, identity).catch(() => [] as Affordance[])),
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
      }),
    );

    const order: Bucket[] = ['needsYou', 'readyToExecute', 'expiringSoon', 'waitingOnOthers'];
    items.sort((a, b) => {
      const d = order.indexOf(a.bucket) - order.indexOf(b.bucket);
      if (d !== 0) return d;
      return (b.tx.proposedAtBlock ?? 0) - (a.tx.proposedAtBlock ?? 0);
    });

    return {
      data: {
        identity,
        items,
        vaultCount: all.length,
        chainHead: health?.chainHead,
        degraded: health?.available === false,
      },
      changed: false,
    };
  },

  render(result, io, ctx) {
    const { identity, items, vaultCount, chainHead, degraded } = result.data;

    if (ctx.flags.quiet) return;

    const contact = ctx.contactName(identity);
    io.out(
      `acting as ${identity}${contact ? ` (${safeText(contact, 40)})` : ''}    ${vaultCount} vault${vaultCount === 1 ? '' : 's'}`,
    );
    if (degraded) {
      io.err('warning: indexer unavailable — this inbox is incomplete, not empty.');
    }
    if (items.length === 0) {
      io.out('');
      io.out('  Nothing waiting on you.');
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
    return {
      identity: result.data.identity,
      vaultCount: result.data.vaultCount,
      degraded: result.data.degraded,
      counts: {
        needsYou: result.data.items.filter((i) => i.bucket === 'needsYou').length,
        readyToExecute: result.data.items.filter((i) => i.bucket === 'readyToExecute').length,
        expiringSoon: result.data.items.filter((i) => i.bucket === 'expiringSoon').length,
        waitingOnOthers: result.data.items.filter((i) => i.bucket === 'waitingOnOthers').length,
      },
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
      degraded: { type: 'boolean' },
      counts: { type: 'object' },
      items: { type: 'array' },
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
    const result = await inboxCommand.run!(ctx, { limit: '25' }, signal);
    const count = result.data.items.filter(
      (i) => i.bucket === 'needsYou' || i.bucket === 'readyToExecute',
    ).length;
    return { data: { count }, changed: false };
  },
  render: (result, io) => io.out(String(result.data.count)),
  toJson: (r) => ({ count: r.data.count }),
  outputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
};
