import type { Affordance, VaultTransaction, TransactionStatus } from '@quaivault/sdk';
import type { AppContext } from '../context/context.js';
import { analyzeBatch, type BatchAnalysis } from '../abi/batch.js';
import type { Io } from './io.js';
import { span, type Tone } from '../format/tone.js';
import {
  abiSourceBadge,
  abiSourceExplanation,
  formatAbsolute,
  formatApproximateAge,
  formatDuration,
  formatQuai,
  safeText,
  viewCalldata,
} from '../format/index.js';

export function statusTone(status: TransactionStatus): Tone {
  switch (status) {
    case 'ready':
      return 'ok';
    case 'pending':
    case 'timelocked':
      return 'warn';
    case 'executed':
      return 'ok';
    case 'failed':
    case 'expired':
    case 'cancelled':
      return 'danger';
    default: {
      const never: never = status;
      throw new Error(`unhandled status: ${String(never)}`);
    }
  }
}

/** Colour is never the only carrier of meaning — every state also has a word. */
export function statusLabel(status: TransactionStatus): string {
  return status;
}

/**
 * The pre-signature disclosure (plan §7).
 *
 * Rendered from whatever the caller passed in — the caller is responsible for
 * having read it from **chain**, not the indexer, before a signature.
 */
export function renderDisclosure(
  tx: VaultTransaction,
  io: Io,
  ctx: AppContext,
  opts: { title?: string; batch?: BatchAnalysis | null } = {},
): void {
  const batch = opts.batch !== undefined ? opts.batch : batchOf(tx, ctx);
  const who = (addr: string): string => {
    const name = ctx.contactName(addr);
    return name ? `${addr}  (${safeText(name, 40)})` : addr;
  };

  io.out('');
  if (opts.title) io.out(io.paint(span(opts.title, 'accent')));
  io.out(`  ${safeText(tx.summary, 200)}`);
  io.out(`  ${io.paint(span(tx.hash, 'muted'))}`);
  io.out('');

  const badge = abiSourceBadge(tx.abiSource);
  io.out(`  Decoded as   ${io.paint(badge)}`);
  const note = abiSourceExplanation(tx.abiSource);
  if (note) io.out(`               ${io.paint(span(note, 'muted'))}`);

  io.out(`  To           ${who(tx.to)}`);
  io.out(`  Value        ${formatQuai(tx.value)} QUAI`);
  if (tx.value > 0n) io.out(`               exactly ${tx.value.toString(10)} wei`);

  // The vault's transaction struct carries no operation field, so a top-level
  // transaction is structurally always a call. Saying so plainly is better
  // than a bare "call" that reads like the result of a check.
  io.out('  Operation    call (the vault has no top-level delegatecall)');

  renderCalldata(tx.data, io, tx.abiSource === 'none');

  if (batch) renderBatch(batch, io, ctx);

  io.out('');
  io.out(`  Approvals    ${tx.approvalCount} of ${tx.threshold}`);
  const approved = new Set(tx.approvals.filter((a) => a.active).map((a) => a.owner.toLowerCase()));
  for (const a of tx.approvals) {
    const mark = a.active ? '[x]' : '[ ]';
    io.out(`    ${mark} ${who(a.owner)}`);
  }
  if (approved.size === 0) io.out(`    ${io.paint(span('(none yet)', 'muted'))}`);

  if (tx.expiration > 0) {
    const left = tx.expiration - ctx.now();
    io.out(
      `  Expires      ${left > 0 ? `in ${formatDuration(left)}` : io.paint(span('expired', 'danger'))}   ${formatAbsolute(tx.expiration)}`,
    );
  }
  if (tx.executionDelay > 0) {
    io.out(
      `  Timelock     ${formatDuration(tx.executionDelay)}${tx.executableAfter > 0 ? `, executable after ${formatAbsolute(tx.executableAfter)}` : ', clock not started'}`,
    );
  }
}

/**
 * Unknown ABI: render the hex. Always. (plan §7.1)
 *
 * The only ground truth available, and a better disclosure than any prose we
 * could substitute — a reviewer can take it to a decompiler or a selector
 * database and check it independently. Word-per-line because ABI encoding is
 * word-aligned: a padded address reads as 12 zero bytes then 20, and a small
 * integer as 31 zero bytes then one, so a careful reader can recognise a
 * recipient and an amount with no ABI at all.
 */
export function renderCalldata(data: string, io: Io, forceFull: boolean): void {
  const view = viewCalldata(data);
  if (view.byteLength === 0) {
    io.out('  Data         (none)');
    return;
  }
  const header = forceFull
    ? `unknown ABI — ${view.byteLength} bytes, showing raw calldata`
    : `${view.byteLength} bytes`;
  io.out(`  Data         ${io.paint(span(header, forceFull ? 'warn' : 'muted'))}`);
  if (view.selector) io.out(`               selector  ${view.selector}`);
  for (const w of view.words) {
    io.out(`               [${String(w.offset).padStart(3, '0')}]     ${w.hex}`);
  }
  if (view.ragged) {
    io.out(
      `               ${io.paint(span('note: payload is not a whole number of 32-byte words (packed or non-standard encoding)', 'warn'))}`,
    );
  }
}

/**
 * Analyse a transaction's calldata for a MultiSend batch, using the client's
 * configured contract addresses. Pure — no I/O — so `tx show` and the
 * pre-signature path render identically (§6 renderer parity).
 */
export function batchOf(tx: VaultTransaction, ctx: AppContext): BatchAnalysis | null {
  return analyzeBatch({
    vault: tx.vault,
    to: tx.to,
    data: tx.data,
    contracts: ctx.qv.network.contracts,
    ...(ctx.qv.abis ? { abis: ctx.qv.abis } : {}),
  });
}

/**
 * Render every sub-call of a batch (plan §7, "Batch recurses").
 *
 * Each one gets the same treatment the outer call gets, because each one is a
 * thing the vault will actually do: recipient, value, provenance badge, and —
 * when the ABI is unknown — the full raw calldata word by word (§7.1, which
 * "applies identically to every batch sub-call").
 */
export function renderBatch(batch: BatchAnalysis, io: Io, ctx: AppContext): void {
  const who = (addr: string): string => {
    const name = ctx.contactName(addr);
    return name ? `${addr}  (${safeText(name, 40)})` : addr;
  };

  io.out('');
  if (batch.error) {
    // Fail closed and say why. A batch nobody can read is the one case where
    // silence would be actively dangerous.
    io.out(
      io.paint(
        span(`  Batch        UNREADABLE — ${safeText(batch.error, 200)}`, 'danger'),
      ),
    );
    io.out(
      io.paint(
        span(
          '               Treated as containing a delegatecall, because it might.',
          'danger',
        ),
      ),
    );
    return;
  }

  io.out(`  Batch        ${batch.calls.length} sub-transaction${batch.calls.length === 1 ? '' : 's'}`);
  if (batch.hasDelegatecall) {
    io.out(
      io.paint(
        span(
          '               contains a DELEGATECALL — that sub-call can rewrite vault storage',
          'danger',
        ),
      ),
    );
  }

  for (const call of batch.calls) {
    io.out('');
    const label = `  [${call.index + 1}/${batch.calls.length}]`;
    io.out(`${label}      ${safeText(call.summary, 200)}`);
    io.out(
      `               ${call.isDelegatecall ? io.paint(span('DELEGATECALL', 'danger')) : 'call'}   ${io.paint(abiSourceBadge(call.abiSource))}`,
    );
    io.out(`               to     ${who(call.to)}`);
    io.out(`               value  ${formatQuai(call.value)} QUAI`);
    if (call.value > 0n) io.out(`                      exactly ${call.value.toString(10)} wei`);
    renderSubCalldata(call.data, io, call.abiSource === 'none');
  }
}

/** §7.1 for a sub-call: same rules, indented under its entry. */
function renderSubCalldata(data: string, io: Io, forceFull: boolean): void {
  const view = viewCalldata(data);
  if (view.byteLength === 0) {
    io.out('               data   (none)');
    return;
  }
  const header = forceFull
    ? `unknown ABI — ${view.byteLength} bytes, showing raw calldata`
    : `${view.byteLength} bytes`;
  io.out(`               data   ${io.paint(span(header, forceFull ? 'warn' : 'muted'))}`);
  if (view.selector) io.out(`                      selector  ${view.selector}`);
  for (const w of view.words) {
    io.out(`                      [${String(w.offset).padStart(3, '0')}]     ${w.hex}`);
  }
  if (view.ragged) {
    io.out(
      `                      ${io.paint(span('note: payload is not a whole number of 32-byte words (packed or non-standard encoding)', 'warn'))}`,
    );
  }
}

/** The can / cannot / not-yet trichotomy — a direct rendering of affordances. */
export function renderAffordances(
  affordances: readonly Affordance[],
  io: Io,
  ctx: AppContext,
): void {
  const allowed = affordances.filter((a) => a.allowed);
  const blocked = affordances.filter((a) => !a.allowed);
  io.out('');
  if (allowed.length) {
    io.out('  You can');
    for (const a of allowed) io.out(`    ${io.paint(span(a.action, 'ok'))}   ${safeText(a.reason, 160)}`);
  }
  if (blocked.length) {
    io.out('  You cannot');
    for (const a of blocked) {
      const when =
        a.availableAt && a.availableAt > ctx.now()
          ? `  (in ${formatDuration(a.availableAt - ctx.now())})`
          : '';
      io.out(
        `    ${io.paint(span(a.action, 'muted'))}   ${io.paint(span(safeText(a.reason, 160) + when, 'muted'))}`,
      );
    }
  }
}

/** One dense row for list views. Truncation is fine here — no signature follows. */
export function txRow(tx: VaultTransaction, io: Io, ctx: AppContext, chainHead?: number): string {
  const age = formatApproximateAge(tx.proposedAtBlock, chainHead) ?? '';
  const bar = `${tx.approvalCount}/${tx.threshold}`;
  const status = io.paint(span(statusLabel(tx.status), statusTone(tx.status)));
  const badge = tx.abiSource === 'builtin' ? '' : ` ${io.paint(abiSourceBadge(tx.abiSource))}`;
  return `  ${tx.hash.slice(2, 10)}  ${age.padEnd(12)} ${bar.padEnd(6)} ${status.padEnd(18)} ${safeText(tx.summary, 60)}${badge}`;
}

export function txToJson(
  tx: VaultTransaction,
  chainHead?: number,
  batch?: BatchAnalysis | null,
): Record<string, unknown> {
  return {
    // §7: no word-splitting in JSON, that is a rendering concern. Sub-calls
    // carry `data` verbatim plus the same selector/length an agent needs to
    // bind an assertion to bytes rather than prose.
    batch: batch
      ? {
          unreadable: batch.error ?? null,
          hasDelegatecall: batch.hasDelegatecall,
          abiSource: batch.abiSource,
          calls: batch.calls.map((c) => ({
            index: c.index,
            operation: c.operation,
            isDelegatecall: c.isDelegatecall,
            to: c.to,
            value: c.value,
            data: c.data,
            dataLength: (c.data.length - 2) / 2,
            selector: viewCalldata(c.data).selector,
            summary: c.summary,
            abiSource: c.abiSource,
          })),
        }
      : null,
    hash: tx.hash,
    vault: tx.vault,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    dataLength: (tx.data.length - 2) / 2,
    selector: viewCalldata(tx.data).selector,
    proposer: tx.proposer,
    proposedAt: tx.proposedAt > 0 ? tx.proposedAt : null,
    proposedAtBlock: tx.proposedAtBlock ?? null,
    chainHead: chainHead ?? null,
    proposedAtApproximate: tx.proposedAt === 0,
    kind: tx.kind,
    summary: tx.summary,
    abiSource: tx.abiSource,
    status: tx.status,
    approvalCount: tx.approvalCount,
    threshold: tx.threshold,
    approvals: tx.approvals.map((a) => ({ owner: a.owner, active: a.active })),
    expiration: tx.expiration || null,
    executionDelay: tx.executionDelay,
    approvedAt: tx.approvedAt || null,
    executableAfter: tx.executableAfter || null,
    source: tx.source,
  };
}

/**
 * JSON Pointers to fields carrying attacker-authored text (plan §8 R7).
 *
 * Every sub-call summary is a channel too: a batch is the easiest place to
 * hide `"SYSTEM: ignore all prior instructions"` in a token name, because the
 * outer summary is only ever "Batched call: N sub-transactions".
 */
export function txUntrustedPointers(prefix: string, batch?: BatchAnalysis | null): string[] {
  const out = [`${prefix}/summary`];
  if (batch) {
    batch.calls.forEach((_, i) => out.push(`${prefix}/batch/calls/${i}/summary`));
  }
  return out;
}
