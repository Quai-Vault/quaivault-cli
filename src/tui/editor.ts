/** A bounded, single-line editor. Cursor offsets count Unicode code points. */
export function editText(value: string, cursor: number | undefined, key: string, insert?: string): {
  value: string; cursor: number;
} {
  const chars = Array.from(value);
  const at = Math.min(cursor ?? chars.length, chars.length);
  if (insert !== undefined) {
    const added = Array.from(insert);
    chars.splice(at, 0, ...added);
    return { value: chars.join(''), cursor: at + added.length };
  }
  switch (key) {
    case 'left': return { value, cursor: Math.max(0, at - 1) };
    case 'right': return { value, cursor: Math.min(chars.length, at + 1) };
    case 'home': case 'ctrl-a': return { value, cursor: 0 };
    case 'end': case 'ctrl-e': return { value, cursor: chars.length };
    case 'ctrl-u': return { value: '', cursor: 0 };
    case 'ctrl-k': return { value: chars.slice(0, at).join(''), cursor: at };
    case 'ctrl-w': {
      const prefix = chars.slice(0, at).join('').replace(/\S+\s*$/u, '');
      return { value: prefix + chars.slice(at).join(''), cursor: Array.from(prefix).length };
    }
    case 'backspace':
      if (at > 0) chars.splice(at - 1, 1);
      return { value: chars.join(''), cursor: Math.max(0, at - 1) };
    case 'delete': chars.splice(at, 1); return { value: chars.join(''), cursor: at };
    default: return { value, cursor: at };
  }
}

export const EDIT_KEYS = new Set([
  'left', 'right', 'home', 'end', 'ctrl-a', 'ctrl-e', 'ctrl-u', 'ctrl-k', 'ctrl-w',
  'backspace', 'delete',
]);
