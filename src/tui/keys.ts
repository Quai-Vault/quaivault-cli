/**
 * Ink's `useInput` shape → the reducer's key vocabulary.
 *
 * Split out and pure so the mapping is testable without a terminal. The
 * hand-rolled predecessor decoded four escape sequences inline in the draw
 * loop and silently dropped everything else, which is why arrow keys worked
 * and shift-tab did not.
 */

/** The subset of Ink's `Key` this surface reacts to. */
export interface InkKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  shift?: boolean;
}

/**
 * Returns the reducer key name, or `null` for input the TUI ignores.
 *
 * Named keys are checked before printable input, because Ink reports `tab`
 * with `input === '\t'` and a form would otherwise type a literal tab into a
 * field.
 */
/**
 * A paste that arrived on the key channel.
 *
 * `usePaste` handles the normal case: it turns on bracketed-paste mode and
 * delivers the text on its own channel. A terminal that does not support
 * bracketed paste sends the characters as ordinary input, and Ink hands the
 * whole run to `useInput` as one multi-character string — which `mapKey`
 * drops, because it admits single characters only. That is why pasting an
 * address did nothing.
 *
 * Accepted only when every character is printable and no named key flag is
 * set, so an escape sequence Ink failed to parse can never be typed into a
 * field that feeds `qv propose`.
 */
export function pastedText(input: string, key: InkKey): string | null {
  if (input.length < 2) return null;
  if (
    key.ctrl ||
    key.tab ||
    key.escape ||
    key.return ||
    key.backspace ||
    key.delete ||
    key.upArrow ||
    key.downArrow ||
    key.leftArrow ||
    key.rightArrow
  ) {
    return null;
  }
  return /^[^\p{Cc}\p{Cf}]+$/u.test(input) ? input : null;
}

export function mapKey(input: string, key: InkKey): string | null {
  if (key.tab) return key.shift ? 'shift-tab' : 'tab';
  if (key.escape) return 'escape';
  if (key.return) return 'return';
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.backspace || key.delete) return 'backspace';
  if (key.ctrl && input === 'u') return 'ctrl-u';
  // Ctrl-anything-else is a control gesture we do not handle; it must never
  // reach a text field as a character.
  if (key.ctrl) return null;
  if (input.length === 1 && input >= ' ') return input;
  return null;
}
