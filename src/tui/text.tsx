import { Text } from 'ink';
import stringWidth from 'string-width';
import { fit } from '../format/cells.js';
export { fit, padCells } from '../format/cells.js';

/** Keep the insertion point visible in a long value without altering the buffer. */
export function InputValue({ value, cursor, width }: {
  value: string; cursor?: number; width: number;
}): React.ReactElement {
  const chars = Array.from(value);
  const at = Math.min(cursor ?? chars.length, chars.length);
  let start = at;
  let used = 1;
  const max = Math.max(3, width);
  while (start > 0 && used + stringWidth(chars[start - 1]!) < max - 1) {
    used += stringWidth(chars[--start]!);
  }
  const prefix = (start ? '…' : '') + chars.slice(start, at).join('');
  const remaining = max - stringWidth(prefix) - 1;
  return <Text>{prefix}<Text inverse color="cyan">{chars[at] ?? ' '}</Text>{fit(chars.slice(at + 1).join(''), remaining)}</Text>;
}
