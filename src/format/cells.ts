import stringWidth from 'string-width';
import { safeText } from './index.js';

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Clamp by terminal cells, preserving whole Unicode graphemes. */
export function fit(value: string, width: number): string {
  const clean = safeText(value, value.length + 1);
  const max = Math.max(0, width);
  if (stringWidth(clean) <= max) return clean;
  let out = '';
  for (const { segment } of segments.segment(clean)) {
    if (stringWidth(out + segment) > max - 1) break;
    out += segment;
  }
  return max ? out + '…' : '';
}

export function padCells(value: string, width: number): string {
  const out = fit(value, width);
  return out + ' '.repeat(Math.max(0, width - stringWidth(out)));
}

