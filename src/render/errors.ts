import { QuaiVaultError } from '@quaivault/sdk';
import type { Io } from './io.js';
import { span } from '../format/tone.js';
import { safeText } from '../format/index.js';
import type { JsonValue } from '../util/json.js';

export interface RenderedError {
  code: string;
  message: string;
  remediation?: string;
  /** Executable commands that would resolve this. The CLI's value-add. */
  next?: string[];
}

/**
 * Map an SDK error code to commands that would fix it.
 *
 * The SDK owns the *wording* of `remediation`; only the CLI can render the
 * actual invocation. A missing entry is deliberate, not an oversight — the
 * registry test asserts every known code is either mapped or explicitly listed
 * as having no command.
 */
const NO_COMMAND = Symbol('no-command');
const REMEDY: Record<string, string[] | typeof NO_COMMAND> = {
  NO_SIGNER: ['qv key import', 'qv key ls'],
  NO_INDEXER: ['qv status'],
  POLICY: ['qv policy show'],
  CONFIG: ['qv doctor'],
  VALIDATION: NO_COMMAND,
  PRECONDITION: NO_COMMAND,
  NOT_FOUND: NO_COMMAND,
  REVERT: NO_COMMAND,
  ABORTED: NO_COMMAND,
  INDEXER_QUERY: ['qv status'],
  SALT_MINING: NO_COMMAND,
  STALE_PROPOSAL: NO_COMMAND,
};

export function remedyFor(code: string): string[] | undefined {
  const v = REMEDY[code];
  return v === NO_COMMAND || v === undefined ? undefined : v;
}

/**
 * Normalize any thrown value into something safe to print.
 *
 * Never `util.inspect` a raw error and never `JSON.stringify` one: a `quais`
 * provider error carries `.info.payload` — the full JSON-RPC request body,
 * sometimes including the endpoint — and Node's default error printing walks
 * the `cause` chain. `QuaiVaultError.toJSON()` deliberately omits `cause`;
 * everything else gets reduced to `{name, message}`.
 */
export function normalizeError(err: unknown): RenderedError {
  if (err instanceof QuaiVaultError) {
    const json = err.toJSON();
    const code = typeof json.code === 'string' ? json.code : 'UNKNOWN';
    return {
      code,
      message: safeText(err.message, 512) || 'Unknown error',
      remediation:
        typeof json.remediation === 'string' ? safeText(json.remediation, 512) : undefined,
      next: remedyFor(code),
    };
  }
  if (err && typeof err === 'object' && 'code' in err) {
    const bag = err as { code?: unknown; message?: unknown; remediation?: unknown };
    if (typeof bag.code === 'string') {
      return {
        code: bag.code,
        message: safeText(bag.message, 512) || 'Unknown error',
        remediation: typeof bag.remediation === 'string' ? bag.remediation : undefined,
        next: remedyFor(bag.code),
      };
    }
  }
  if (err instanceof Error) {
    return { code: 'UNKNOWN', message: safeText(err.message, 512) || err.name };
  }
  return { code: 'UNKNOWN', message: 'Unknown error' };
}

export function errorToJson(e: RenderedError): JsonValue {
  const out: Record<string, JsonValue> = { code: e.code, message: e.message };
  if (e.remediation) out.remediation = e.remediation;
  if (e.next?.length) out.next = e.next;
  return out;
}

export function renderError(e: RenderedError, io: Io, debug: boolean, raw?: unknown): void {
  io.err(`${io.paint(span('error:', 'danger'))} ${io.paint(span(e.code, 'danger'))}`);
  io.err(`  ${e.message}`);
  if (e.remediation) io.err(`  ${io.paint(span(e.remediation, 'muted'))}`);
  if (e.next?.length) {
    io.err('');
    io.err('  what to do');
    for (const cmd of e.next) io.err(`    ${io.paint(span(cmd, 'accent'))}`);
  }
  if (debug && raw instanceof Error && raw.stack) {
    io.err('');
    io.err(io.paint(span(raw.stack, 'muted')));
  }
}
