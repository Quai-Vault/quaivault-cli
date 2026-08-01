/**
 * Formatters return a value, not an escape sequence (plan §5.2).
 *
 * `picocolors` emits ANSI inline; Ink wants `<Text color=…>`. If a formatter
 * returned a pre-coloured string it would be unusable in the TUI, and the two
 * surfaces would drift on exactly the thing that must not drift: how a
 * low-confidence decode looks next to a verified one.
 */
export type Tone =
  | 'plain'
  | 'muted'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'accent'
  /** Attacker-authored text. Rendered plainly and never trusted for meaning. */
  | 'untrusted';

export interface Span {
  text: string;
  tone: Tone;
}

export function span(text: string, tone: Tone = 'plain'): Span {
  return { text, tone };
}

export function plain(text: string): Span {
  return span(text, 'plain');
}

/** Concatenate spans into a plain string, discarding tone. */
export function flatten(spans: readonly Span[]): string {
  return spans.map((s) => s.text).join('');
}
