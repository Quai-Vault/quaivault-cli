import { sanitizeText } from '@quaivault/sdk';
import type { AbiSource } from '@quaivault/sdk';
import { type Span, span } from './tone.js';

export * from './tone.js';

/** Quai mainnet/Orchard target block time. Used only for approximate ages. */
export const SECONDS_PER_BLOCK = 5;

// ---------------------------------------------------------------- addresses

/**
 * Shorten for dense list views only. Never for a confirmation surface, and
 * never for anything the user might copy — plan §4.1 requires full identifiers
 * wherever a signature can follow.
 */
export function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 8)}…`;
}

/** A hash prefix short enough to type but long enough not to collide. */
export function hashPrefix(hash: string, len = 8): string {
  return hash.replace(/^0x/, '').slice(0, len);
}

// ------------------------------------------------------------------ amounts

const WEI_PER_QUAI = 10n ** 18n;

/**
 * Exact decimal QUAI. Never rounds, never clamps small values to `<0.001` —
 * a rounded amount on a signing surface is a money bug (plan §4.1).
 */
export function formatQuai(wei: bigint): string {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / WEI_PER_QUAI;
  const frac = abs % WEI_PER_QUAI;
  const wholeStr = groupThousands(whole.toString(10));
  if (frac === 0n) return `${neg ? '-' : ''}${wholeStr}`;
  const fracStr = frac.toString(10).padStart(18, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${wholeStr}.${fracStr}`;
}

/** Format a token amount at arbitrary decimals. Exact, like `formatQuai`. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals <= 0) return groupThousands(amount.toString(10));
  const base = 10n ** BigInt(decimals);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = groupThousands((abs / base).toString(10));
  const frac = (abs % base).toString(10).padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Parse decimal QUAI to wei. Throws on anything ambiguous. */
export function parseQuai(input: string): bigint {
  return parseUnits(input, 18);
}

export function parseUnits(input: string, decimals: number): bigint {
  const trimmed = input.trim().replace(/_/g, '');
  if (!/^-?\d*(\.\d*)?$/.test(trimmed) || trimmed === '' || trimmed === '.') {
    throw new Error(`Not a decimal number: ${JSON.stringify(input)}`);
  }
  const neg = trimmed.startsWith('-');
  const body = neg ? trimmed.slice(1) : trimmed;
  const [wholePart = '', fracPart = ''] = body.split('.');
  if (fracPart.length > decimals) {
    throw new Error(
      `Too many decimal places: ${JSON.stringify(input)} has ${fracPart.length}, max ${decimals}.`,
    );
  }
  const combined = `${wholePart || '0'}${fracPart.padEnd(decimals, '0')}`;
  const value = BigInt(combined);
  return neg ? -value : value;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// -------------------------------------------------------------------- time

/**
 * Durations render as `1d 6h`, `2h 30m`, `45s`. Two units maximum — a third
 * adds noise without adding a decision.
 */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return '0s';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}

/** An exact contract timestamp rendered relative to now. No tilde. */
export function formatRelativePast(unixSeconds: number, now: number): string {
  const delta = now - unixSeconds;
  if (delta < 5) return 'just now';
  return `${formatDuration(delta)} ago`;
}

export function formatAbsolute(unixSeconds: number): string {
  return `${new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

/**
 * Proposal age derived from a block delta, because `proposedAt` is 0 on
 * indexer reads (plan §2.2). **Always prefixed with `~`** — the tilde is the
 * visible difference between a value safe to act on and one that is not.
 */
export function formatApproximateAge(
  proposedAtBlock: number | undefined,
  chainHead: number | undefined,
): string | null {
  if (!proposedAtBlock || !chainHead || chainHead < proposedAtBlock) return null;
  const seconds = (chainHead - proposedAtBlock) * SECONDS_PER_BLOCK;
  return `~${formatDuration(seconds)} ago`;
}

// -------------------------------------------------------------- provenance

/**
 * `abiSource` decides how much a reader should trust the summary next to it.
 * SDK 0.5.0 deliberately does not hedge `heuristic` summaries — "the field
 * carries the uncertainty instead" — so this badge is the only place a user
 * learns that "Transfer 100 USDC" was a four-byte guess.
 */
export function abiSourceBadge(source: AbiSource): Span {
  switch (source) {
    case 'builtin':
      return span('verified', 'ok');
    case 'supplied':
      return span('supplied ABI', 'warn');
    case 'heuristic':
      return span('guessed from selector', 'warn');
    case 'none':
      return span('unknown', 'danger');
    default: {
      const never: never = source;
      throw new Error(`unhandled abiSource: ${String(never)}`);
    }
  }
}

export function abiSourceExplanation(source: AbiSource): string | null {
  switch (source) {
    case 'builtin':
      return null;
    case 'supplied':
      return 'Decoded with an ABI supplied to this CLI, not one the SDK vouches for.';
    case 'heuristic':
      return 'Identified by selector shape alone. The SDK does not know what contract this address is.';
    case 'none':
      return 'No ABI matched. Raw calldata shown below is the only ground truth.';
    default: {
      const never: never = source;
      throw new Error(`unhandled abiSource: ${String(never)}`);
    }
  }
}

// ---------------------------------------------------------------- calldata

export interface CalldataView {
  selector: string | null;
  words: { offset: number; hex: string }[];
  byteLength: number;
  /** Payload after the selector is not a whole number of 32-byte words. */
  ragged: boolean;
}

/**
 * Lay calldata out for a human with no ABI (plan §7.1).
 *
 * ABI encoding is word-aligned, so one 32-byte word per line is not cosmetic:
 * a padded address reads as 12 zero bytes then 20, and a small integer as 31
 * zero bytes then one. A reviewer can pick out a recipient and an amount with
 * no ABI at all — which is exactly the situation this renders for.
 */
export function viewCalldata(data: string): CalldataView {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const byteLength = Math.floor(hex.length / 2);
  if (hex.length === 0) {
    return { selector: null, words: [], byteLength: 0, ragged: false };
  }
  if (hex.length < 8) {
    return { selector: `0x${hex}`, words: [], byteLength, ragged: true };
  }
  const selector = `0x${hex.slice(0, 8)}`;
  const payload = hex.slice(8);
  const words: { offset: number; hex: string }[] = [];
  for (let i = 0; i < payload.length; i += 64) {
    words.push({ offset: i / 2, hex: payload.slice(i, i + 64) });
  }
  return { selector, words, byteLength, ragged: payload.length % 64 !== 0 };
}

// -------------------------------------------------------------------- text

/**
 * Re-sanitize at our own render boundary.
 *
 * The SDK sanitizes token `symbol`/`name` and revert `.message`, but leaves
 * `DecodedRevert.args`, `DecodedCall.name` and raw indexer rows alone — and
 * nothing sanitizes values from our own config (alias names, contact names).
 * A shared or hostile config file is a real vector for the terminal-escape
 * attack the SDK closed everywhere else.
 */
export function safeText(value: unknown, maxLength = 128): string {
  return sanitizeText(value, maxLength);
}
