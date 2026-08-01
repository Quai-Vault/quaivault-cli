/**
 * The `--json` serialization contract (plan §4.1).
 *
 * Two rules that exist because getting either wrong is a money bug:
 *
 * 1. **Every bigint becomes a decimal string, never a number.** `JSON.stringify`
 *    throws on a bigint outright, and the obvious "fix" — `Number(v)` — silently
 *    loses precision above 2^53, which is 0.009 QUAI. Wei values routinely exceed
 *    it.
 * 2. **Nothing is truncated.** Full hashes, full addresses, full calldata.
 */

export const SCHEMA_VERSION = 1;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

/** Recursively convert bigints to decimal strings. */
export function jsonSafe(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = jsonSafe(v);
    }
    return out;
  }
  // Functions, symbols: not representable, and silently dropping them would
  // hide a bug in a caller's payload shape.
  return null;
}

export interface Envelope {
  schema: number;
  ok: boolean;
  command: string;
  data?: JsonValue;
  error?: JsonValue;
  /** Present on writes. See `changed` semantics in plan §4.1. */
  changed?: boolean | 'unknown';
  retryable?: boolean;
  steps?: JsonValue;
  next?: JsonValue;
  /** JSON Pointers to fields carrying attacker-authored text (plan §8 R7). */
  untrusted?: string[];
  warnings?: string[];
}

export function envelope(input: Envelope): string {
  const ordered: Record<string, JsonValue> = {
    schema: input.schema,
    ok: input.ok,
    command: input.command,
  };
  if (input.changed !== undefined) ordered.changed = input.changed;
  if (input.retryable !== undefined) ordered.retryable = input.retryable;
  if (input.data !== undefined) ordered.data = input.data;
  if (input.steps !== undefined) ordered.steps = input.steps;
  if (input.error !== undefined) ordered.error = input.error;
  if (input.next !== undefined) ordered.next = input.next;
  if (input.untrusted?.length) ordered.untrusted = input.untrusted;
  if (input.warnings?.length) ordered.warnings = input.warnings;
  return JSON.stringify(ordered, null, 2);
}
