import type { Affordance, VaultTransaction, TransactionStatus } from '@quaivault/sdk';
import type { AppContext } from '../context/context.js';
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
  opts: { title?: string } = {},
): void {
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

  // Operation: a delegatecall lets the target rewrite vault storage.
  const isDelegate = isDelegatecall(tx);
  io.out(
    `  Operation    ${isDelegate ? io.paint(span('DELEGATECALL — the target can rewrite vault storage', 'danger')) : 'call'}`,
  );

  renderCalldata(tx.data, io, tx.abiSource === 'none');

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

export function isDelegatecall(tx: VaultTransaction): boolean {
  const op = (tx as unknown as { operation?: number }).operation;
  return op === 1;
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

export function txToJson(tx: VaultTransaction, chainHead?: number): Record<string, unknown> {
  return {
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

/** JSON Pointers to fields carrying attacker-authored text (plan §8 R7). */
export function txUntrustedPointers(prefix: string): string[] {
  return [`${prefix}/summary`];
}
