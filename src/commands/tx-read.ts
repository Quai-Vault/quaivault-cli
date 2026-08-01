import { keccak256 } from 'quais';
import type { Affordance, VaultTransaction, TransactionStatus } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError, PreconditionError } from '../context/context.js';
import type { AppContext } from '../context/context.js';
import { span } from '../format/tone.js';
import { formatAbsolute, formatApproximateAge, formatDuration, safeText } from '../format/index.js';
import type { Io } from '../render/io.js';
import {
  batchOf,
  renderAffordances,
  renderDisclosure,
  statusLabel,
  statusTone,
  txRow,
  txToJson,
  txUntrustedPointers,
} from '../render/transaction.js';
import type { BatchAnalysis } from '../abi/batch.js';

/**
 * Resolve a possibly-abbreviated hash against the vault's transactions.
 *
 * Prefix matching is human ergonomics; it is **disabled under `--json`**
 * because proposal hashes are grindable and an agent should always pass the
 * full 66 characters (plan §4.3).
 */
export async function resolveTxHash(
  ctx: AppContext,
  vault: string,
  input: string,
): Promise<string> {
  const raw = input.trim();
  const full = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(full)) return full;
  if (ctx.flags.json) {
    throw new UsageError(
      'Hash prefix matching is disabled under --json.',
      'Pass the full 66-character transaction hash.',
    );
  }
  const needle = raw.replace(/^0x/, '').toLowerCase();
  if (needle.length < 4) {
    throw new UsageError('Hash prefix too short.', 'Use at least 4 hex characters.');
  }
  const v = ctx.qv.vault(vault);
  const [pending, history] = await Promise.all([
    v.pendingTransactions().catch((): VaultTransaction[] => []),
    v
      .transactionHistory({ limit: 100 })
      .then((p) => p.data)
      .catch((): VaultTransaction[] => []),
  ]);
  const seen = new Map<string, VaultTransaction>();
  for (const tx of [...pending, ...history]) seen.set(tx.hash.toLowerCase(), tx);
  const matches = [...seen.keys()].filter((h) => h.slice(2).startsWith(needle));
  if (matches.length === 1) return matches[0] as string;
  if (matches.length === 0) {
    throw new UsageError(`No transaction matching ${JSON.stringify(raw)} on this vault.`);
  }
  throw new UsageError(
    `Ambiguous prefix ${JSON.stringify(raw)} — ${matches.length} matches.`,
    matches.slice(0, 5).map((m) => `  ${m}`).join('\n'),
  );
}

// ------------------------------------------------------------------ tx show

interface TxShowData {
  tx: VaultTransaction;
  affordances: Affordance[];
  caller?: string;
  chainHead?: number;
  /** Null when the transaction is not a MultiSend batch. */
  batch: BatchAnalysis | null;
}

export const txShowCommand: CommandSpec<{ vault?: string; hash: string }, TxShowData> = {
  path: ['tx', 'show'],
  describe: 'Full detail of one transaction, with what you can do about it',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  needs: { indexer: 'preferred' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const hash = await resolveTxHash(ctx, address, input.hash);
    const vault = ctx.qv.vault(address);
    const caller = ctx.identity();
    const [tx, health] = await Promise.all([
      vault.transaction(hash),
      ctx.qv.indexerHealth().catch(() => null),
    ]);
    let affordances: Affordance[] = [];
    if (caller) {
      affordances = await vault.affordances(hash, caller).catch(() => []);
    }
    const next: string[] = [];
    for (const a of affordances.filter((x) => x.allowed)) {
      if (a.action === 'approve') next.push(`qv tx approve ${address} ${hash.slice(0, 10)}`);
      if (a.action === 'execute') next.push(`qv tx execute ${address} ${hash.slice(0, 10)}`);
    }
    // Computed once here so `render` and `toJson` cannot disagree about what
    // is inside a batch, and so the untrusted-pointer list covers every
    // sub-call summary rather than just the outer one (§8 R7).
    const batch = batchOf(tx, ctx);
    return {
      data: { tx, affordances, caller, chainHead: health?.chainHead, batch },
      changed: false,
      next: next.length ? next : undefined,
      untrusted: txUntrustedPointers('', batch),
    };
  },

  render(result, io, ctx) {
    const { tx, affordances, caller, chainHead } = result.data;
    renderDisclosure(tx, io, ctx, { batch: result.data.batch });
    io.out('');
    io.out(
      `  Status       ${io.paint(span(statusLabel(tx.status), statusTone(tx.status)))}`,
    );
    const age = formatApproximateAge(tx.proposedAtBlock, chainHead);
    const proposed =
      tx.proposedAt > 0
        ? `${formatDuration(ctx.now() - tx.proposedAt)} ago   ${formatAbsolute(tx.proposedAt)}`
        : (age ?? 'unknown');
    io.out(`  Proposed     ${proposed} by ${tx.proposer}`);
    if (tx.decodedRevert) {
      io.out('');
      io.out(`  ${io.paint(span('Reverted:', 'danger'))} ${safeText(tx.decodedRevert.message, 300)}`);
    }
    if (caller) renderAffordances(affordances, io, ctx);
    else {
      io.out('');
      io.err('  Set an identity to see what you can do: qv use --as 0x…  (no key required)');
    }
  },

  toJson(result) {
    return {
      ...txToJson(result.data.tx, result.data.chainHead, result.data.batch),
      caller: result.data.caller ?? null,
      affordances: result.data.affordances.map((a) => ({
        action: a.action,
        allowed: a.allowed,
        reason: a.reason,
        availableAt: a.availableAt ?? null,
        blockedBy: a.blockedBy ?? null,
      })),
      // Bind an agent to the bytes, not to any interpretation of them
      // (§3.4). Every field here has a matching --expect-* flag on the write
      // commands, and `dataHash` is the one that actually closes R7: prose can
      // be attacker-authored, a keccak of the calldata cannot.
      verify: {
        to: result.data.tx.to,
        value: result.data.tx.value.toString(10),
        operation: 'call',
        selector: result.data.tx.data.slice(0, 10),
        dataHash: keccak256(result.data.tx.data === '0x' ? '0x' : result.data.tx.data),
        abiSource: result.data.tx.abiSource,
        // A batch's real provenance is its weakest sub-call, and its real
        // danger is an inner delegatecall. Both are invisible in the fields
        // above, which describe only the outer multiSend.
        batchHasDelegatecall: result.data.batch?.hasDelegatecall ?? false,
        batchAbiSource: result.data.batch?.abiSource ?? null,
        batchUnreadable: result.data.batch?.error ?? null,
      },
    };
  },

  outputSchema: {
    type: 'object',
    description: 'One transaction plus the caller-scoped affordance set.',
    properties: {
      hash: { type: 'string' },
      to: { type: 'string' },
      value: { type: 'string', description: 'wei, decimal string' },
      data: { type: 'string' },
      abiSource: { enum: ['builtin', 'heuristic', 'supplied', 'none'] },
      status: { type: 'string' },
      affordances: { type: 'array' },
      batch: {
        type: ['object', 'null'],
        description:
          'Present when the calldata is a MultiSend batch. `calls[]` carries every ' +
          'sub-call verbatim. `hasDelegatecall` is the only delegatecall signal that ' +
          'exists — the vault transaction struct has no operation field, so a ' +
          'top-level transaction is always a call. `unreadable` is non-null when the ' +
          'payload could not be accounted for byte-exactly, in which case treat the ' +
          'batch as hostile.',
      },
      verify: { type: 'object', description: 'assert against these with --expect-* on writes' },
    },
  },
};

// -------------------------------------------------------------------- tx ls

interface TxListData {
  transactions: VaultTransaction[];
  chainHead?: number;
  total: number | null;
  hasMore: boolean;
  degraded: boolean;
}

function renderList(
  result: { data: TxListData },
  io: Io,
  ctx: AppContext,
): void {
  const { transactions, chainHead, degraded } = result.data;
  if (degraded) {
    io.err(
      'warning: the indexer is unavailable — this list is read from the chain and may be incomplete.',
    );
  }
  if (transactions.length === 0) {
    io.out(degraded ? '  Cannot see transactions (indexer unavailable).' : '  No transactions.');
    return;
  }
  io.out(io.paint(span('  HASH      AGE          APPR   STATE              SUMMARY', 'muted')));
  for (const tx of transactions) io.out(txRow(tx, io, ctx, chainHead));
}

export const txLsCommand: CommandSpec<{ vault?: string; limit?: string }, TxListData> = {
  path: ['tx', 'ls'],
  describe: 'Pending transactions on a vault',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  options: [{ flags: '--limit <n>', description: 'maximum rows', defaultValue: '50' }],
  needs: { indexer: 'preferred' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const limit = Number(input.limit ?? 50);
    const health = await ctx.qv.indexerHealth().catch(() => null);
    let transactions: VaultTransaction[] = [];
    let degraded = false;
    try {
      transactions = await ctx.qv.vault(address).pendingTransactions({ limit });
    } catch {
      degraded = true;
    }
    return {
      data: {
        transactions,
        chainHead: health?.chainHead,
        total: transactions.length,
        hasMore: false,
        degraded: degraded || health?.available === false,
      },
      changed: false,
    };
  },

  render: (result, io, ctx) => renderList(result, io, ctx),
  toJson: (result) => ({
    data: result.data.transactions.map((t) => txToJson(t, result.data.chainHead)),
    total: result.data.total,
    hasMore: result.data.hasMore,
    degraded: result.data.degraded,
  }) as never,
  outputSchema: {
    type: 'object',
    properties: {
      data: { type: 'array' },
      total: { type: ['integer', 'null'], description: 'estimate; branch on hasMore' },
      hasMore: { type: 'boolean', description: 'exact' },
      degraded: { type: 'boolean', description: 'true when results are known to be incomplete' },
    },
  },
};

export const txHistoryCommand: CommandSpec<
  { vault?: string; limit?: string; status?: string },
  TxListData
> = {
  path: ['tx', 'history'],
  describe: 'Executed, cancelled, expired and failed transactions',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  options: [
    { flags: '--limit <n>', description: 'maximum rows', defaultValue: '50' },
    {
      flags: '--status <status>',
      description: 'filter by terminal status',
      choices: ['executed', 'cancelled', 'expired', 'failed'],
    },
  ],
  needs: { indexer: 'required' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const limit = Number(input.limit ?? 50);
    const [page, health] = await Promise.all([
      ctx.qv.vault(address).transactionHistory({ limit }),
      ctx.qv.indexerHealth().catch(() => null),
    ]);
    const wanted = input.status as TransactionStatus | undefined;
    const transactions = wanted ? page.data.filter((t) => t.status === wanted) : page.data;
    return {
      data: {
        transactions,
        chainHead: health?.chainHead,
        total: page.total,
        hasMore: page.hasMore,
        degraded: health?.available === false,
      },
      changed: false,
    };
  },

  render: (result, io, ctx) => renderList(result, io, ctx),
  toJson: (result) => ({
    data: result.data.transactions.map((t) => txToJson(t, result.data.chainHead)),
    total: result.data.total,
    hasMore: result.data.hasMore,
    degraded: result.data.degraded,
  }) as never,
  outputSchema: txLsCommand.outputSchema,
};

// ------------------------------------------------------------------ tx wait

export const txWaitCommand: CommandSpec<
  { vault?: string; hash: string; timeout?: string },
  { hash: string; status: TransactionStatus; ready: boolean }
> = {
  path: ['tx', 'wait'],
  describe: 'Block until a transaction is executable',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'transaction hash or unique prefix', required: true },
  ],
  options: [{ flags: '--timeout <seconds>', description: 'give up after', defaultValue: '900' }],

  async run(ctx, input, signal) {
    const address = ctx.resolveVault(input.vault);
    const hash = await resolveTxHash(ctx, address, input.hash);
    const vault = ctx.qv.vault(address);
    const timeoutMs = Number(input.timeout ?? 900) * 1000;
    try {
      await vault.waitForExecutable(hash, { timeoutMs, signal });
    } catch (err) {
      const tx = await vault.transaction(hash);
      throw new PreconditionError(
        `Transaction is not executable and waiting will not help: status is ${tx.status}.`,
        err instanceof Error ? err.message : undefined,
      );
    }
    const tx = await vault.transaction(hash);
    return {
      data: { hash, status: tx.status, ready: tx.status === 'ready' },
      changed: false,
      next: [`qv tx execute ${address} ${hash.slice(0, 10)}`],
    };
  },

  render(result, io) {
    io.out(`${result.data.hash}  ${result.data.status}`);
  },
  toJson: (r) => ({ hash: r.data.hash, status: r.data.status, ready: r.data.ready }),
  outputSchema: {
    type: 'object',
    properties: { hash: { type: 'string' }, status: { type: 'string' }, ready: { type: 'boolean' } },
  },
};
