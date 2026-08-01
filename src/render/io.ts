 
import pc from 'picocolors';
import type { Span, Tone } from '../format/tone.js';

/**
 * The only module in the CLI permitted to write to stdout or stderr.
 *
 * Stream discipline (plan §4.1): **data to stdout, all chrome to stderr** —
 * warnings, hints, spinners, progress. That is what makes `qv X | jq` work
 * without `--json`, and what stops a warning line corrupting a redirect.
 */
export interface Io {
  /** Machine-consumable output. */
  out(line: string): void;
  /** Human chrome: warnings, hints, progress. Never parsed by anything. */
  err(line: string): void;
  readonly colorEnabled: boolean;
  readonly width: number;
  readonly isTty: boolean;
  paint(span: Span): string;
}

export interface IoOptions {
  color?: 'auto' | 'always' | 'never';
  width?: number;
  isTty?: boolean;
}

const TONE_FN: Record<Tone, (s: string) => string> = {
  plain: (s) => s,
  muted: pc.dim,
  ok: pc.green,
  warn: pc.yellow,
  danger: pc.red,
  accent: pc.cyan,
  // Attacker-authored. Never coloured to look authoritative.
  untrusted: pc.dim,
};

function resolveColor(mode: 'auto' | 'always' | 'never', isTty: boolean): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0') return true;
  return isTty;
}

export function createIo(opts: IoOptions = {}): Io {
  const isTty = opts.isTty ?? Boolean(process.stdout.isTTY);
  const colorEnabled = resolveColor(opts.color ?? 'auto', isTty);
  const width = opts.width ?? (process.stdout.columns || 80);
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    colorEnabled,
    width,
    isTty,
    paint: (s) => (colorEnabled ? TONE_FN[s.tone](s.text) : s.text),
  };
}

/** Buffer-backed Io for tests. No stdout, no colour, fixed width. */
export function createBufferIo(width = 80): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    colorEnabled: false,
    width,
    isTty: false,
    paint: (s) => s.text,
  };
}
