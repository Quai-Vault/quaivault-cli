import { describe, expect, it } from 'vitest';
import {
  abiSourceBadge,
  formatApproximateAge,
  formatDuration,
  formatQuai,
  formatUnits,
  parseQuai,
  parseUnits,
  safeText,
  viewCalldata,
} from '../../src/format/index.js';

describe('formatQuai', () => {
  it('is exact and never rounds', () => {
    expect(formatQuai(0n)).toBe('0');
    expect(formatQuai(10n ** 18n)).toBe('1');
    expect(formatQuai(1_500_000_000_000_000_000n)).toBe('1.5');
    // The GUI clamps this to "<0.001". On a signing surface that is a money bug.
    expect(formatQuai(1n)).toBe('0.000000000000000001');
    expect(formatQuai(999n)).toBe('0.000000000000000999');
  });

  it('groups thousands but never uses exponential notation', () => {
    expect(formatQuai(1_234_567n * 10n ** 18n)).toBe('1,234,567');
    expect(formatQuai(10n ** 40n)).not.toMatch(/e/i);
  });

  it('round-trips through parseQuai', () => {
    for (const wei of [0n, 1n, 10n ** 18n, 123_456_789_012_345_678n, 10n ** 30n]) {
      expect(parseQuai(formatQuai(wei).replace(/,/g, ''))).toBe(wei);
    }
  });
});

describe('parseUnits', () => {
  it('rejects more precision than the token has', () => {
    expect(() => parseUnits('1.1234567', 6)).toThrow(/decimal places/);
    expect(parseUnits('1.123456', 6)).toBe(1_123_456n);
  });

  it('rejects things that are not numbers', () => {
    for (const bad of ['', '.', 'abc', '1.2.3', '0x10']) {
      expect(() => parseUnits(bad, 18), bad).toThrow();
    }
  });
});

describe('formatUnits', () => {
  it('honours token decimals', () => {
    expect(formatUnits(1_000_000n, 6)).toBe('1');
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits(1n, 6)).toBe('0.000001');
  });
});

describe('formatDuration', () => {
  it('renders at most two units', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(90)).toBe('1m 30s');
    expect(formatDuration(3600)).toBe('1h');
    expect(formatDuration(3600 * 25)).toBe('1d 1h');
  });
});

describe('formatApproximateAge', () => {
  it('always marks derived ages with a tilde', () => {
    // The tilde is the visible difference between a value safe to act on and
    // one that is not.
    expect(formatApproximateAge(1000, 1720)).toBe('~1h ago');
  });

  it('returns null rather than guessing when chainHead is unknown', () => {
    expect(formatApproximateAge(1000, undefined)).toBeNull();
    expect(formatApproximateAge(undefined, 2000)).toBeNull();
    expect(formatApproximateAge(2000, 1000)).toBeNull();
  });
});

describe('abiSourceBadge', () => {
  it('distinguishes a verified decode from a selector guess', () => {
    // SDK 0.5.0 deliberately does not hedge heuristic summaries, so this badge
    // is the only place a user learns the difference.
    expect(abiSourceBadge('builtin').text).toBe('verified');
    expect(abiSourceBadge('heuristic').text).toBe('guessed from selector');
    expect(abiSourceBadge('heuristic').tone).not.toBe(abiSourceBadge('builtin').tone);
    expect(abiSourceBadge('none').tone).toBe('danger');
  });
});

describe('viewCalldata', () => {
  const transfer = `0xa9059cbb${'0'.repeat(24)}${'11'.repeat(20)}${'0'.repeat(62)}64`;

  it('splits into a selector and 32-byte words with offsets', () => {
    const v = viewCalldata(transfer);
    expect(v.selector).toBe('0xa9059cbb');
    expect(v.words).toHaveLength(2);
    expect(v.words[0]!.offset).toBe(0);
    expect(v.words[1]!.offset).toBe(32);
    expect(v.words[0]!.hex).toHaveLength(64);
    expect(v.ragged).toBe(false);
  });

  it('flags a payload that is not a whole number of words', () => {
    expect(viewCalldata('0xa9059cbbdeadbeef').ragged).toBe(true);
  });

  it('handles empty calldata', () => {
    const v = viewCalldata('0x');
    expect(v.byteLength).toBe(0);
    expect(v.selector).toBeNull();
  });

  it('never truncates — every byte is present', () => {
    const v = viewCalldata(transfer);
    const rebuilt = `0x${v.selector!.slice(2)}${v.words.map((w) => w.hex).join('')}`;
    expect(rebuilt).toBe(transfer);
  });
});

describe('safeText', () => {
  it('neutralises a terminal-escape forgery', () => {
    // A token named this could otherwise overwrite lines we already printed.
    const forged = '[2A[KAll checks passed';
    expect(safeText(forged)).not.toContain('');
  });

  it('strips bidi overrides that reverse a rendered address', () => {
    expect(safeText('USD‮DCBA')).not.toContain('‮');
  });
});
