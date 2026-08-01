import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AbiSource } from '@quaivault/sdk';
import { abiSourceBadge, formatQuai, safeText } from '../../src/format/index.js';
import { createBufferIo } from '../../src/render/io.js';
import { renderDisclosure, txRow } from '../../src/render/transaction.js';
import { createFakeContext, fakeTx } from '../fake-client.js';
import { ABI_SOURCE_FIXTURES } from '../fixtures/index.js';

/**
 * Renderer parity (plan §6).
 *
 * "`format*()` output byte-identical across surfaces for the `abiSource`
 * badge, amounts, and addresses. **This is what keeps 'one core' honest.**"
 *
 * The failure it guards against is specific and bad: the TUI never calls
 * `render()`, so nothing *forces* it to describe a transaction the way the
 * one-shot surface does. If it grew its own amount formatter or its own
 * provenance badge, it would render provenance differently **on the surface
 * where a signature happens** — a reviewer approving from the TUI would be
 * reading a different claim than the one they verified with `qv tx show`.
 */

const io = () => createBufferIo(100);
const ctx = () => createFakeContext();

const SOURCES: AbiSource[] = ['builtin', 'heuristic', 'supplied', 'none'];

describe('the abiSource badge is one string, everywhere', () => {
  it.each(SOURCES)('renders %s identically in the disclosure and in a list row', (source) => {
    const badge = abiSourceBadge(source).text;
    const tx = ABI_SOURCE_FIXTURES[source];

    const disclosure = io();
    renderDisclosure(tx, disclosure, ctx());
    expect(disclosure.stdout.join('\n'), `disclosure is missing "${badge}"`).toContain(badge);

    // `builtin` is deliberately unbadged in list rows — the absence is the
    // signal, and only the non-default provenances get a marker.
    if (source !== 'builtin') {
      const row = txRow(tx, io(), ctx(), 9_272_855);
      expect(row, `list row is missing "${badge}"`).toContain(badge);
    }
  });

  it('gives each provenance a distinct badge, so the badge carries information', () => {
    const badges = SOURCES.map((s) => abiSourceBadge(s).text);
    expect(new Set(badges).size).toBe(SOURCES.length);
  });

  it('tones heuristic and none as warnings, not as neutral chrome', () => {
    // Colour is a value, not an escape sequence (§5.2), so the tone is
    // checkable rather than being baked into a pre-coloured string.
    expect(abiSourceBadge('builtin').tone).not.toBe(abiSourceBadge('heuristic').tone);
    expect(abiSourceBadge('none').tone).not.toBe(abiSourceBadge('builtin').tone);
  });
});

describe('amounts are formatted in one place', () => {
  const amounts = [
    0n,
    1n,
    1_000_000_000_000_000_000n,
    1_500_000_000_000_000_000n,
    123_456_789_012_345_678_901_234_567_890n,
  ];

  it.each(amounts.map((a) => [a.toString(), a] as const))(
    'renders %s wei through formatQuai in the disclosure',
    (_label, amount) => {
      const b = io();
      renderDisclosure(fakeTx({ value: amount }), b, ctx());
      expect(b.stdout.join('\n')).toContain(formatQuai(amount));
    },
  );

  it('always shows exact wei alongside the human amount for a non-zero value', () => {
    // §7: the value in both QUAI and wei. A rounded amount is not something
    // anyone should sign against.
    const b = io();
    renderDisclosure(fakeTx({ value: 1_500_000_000_000_000_000n }), b, ctx());
    expect(b.stdout.join('\n')).toContain('1500000000000000000 wei');
  });
});

describe('addresses are never truncated where a signature can follow', () => {
  it('prints the full recipient in the disclosure', () => {
    const tx = fakeTx();
    const b = io();
    renderDisclosure(tx, b, ctx());
    const text = b.stdout.join('\n');
    expect(text).toContain(tx.to);
    expect(text).toContain(tx.hash);
  });

  it('applies sanitizeText to attacker-authored text on every surface', () => {
    // §5.2: sanitizeText lives in format/, not render/. Otherwise the TUI
    // reintroduces the terminal-escape injection the SDK closed — and Ink is
    // worse, because an escape inside a component corrupts the frame diff.
    const hostile = '[31mred[0m';
    expect(safeText(hostile, 100)).not.toContain('');
    expect(safeText(hostile, 100)).not.toContain('');

    const b = io();
    renderDisclosure(fakeTx({ summary: hostile }), b, ctx());
    expect(b.stdout.join('\n')).not.toContain('[31m');
  });
});

/**
 * The structural half. The tests above prove the surfaces agree *today*; this
 * proves they cannot quietly stop agreeing, by refusing to let a surface grow
 * its own formatter at all.
 */
describe('no surface reimplements formatting', () => {
  function sourcesUnder(dir: string): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    const walk = (d: string): void => {
      for (const entry of readdirSync(d)) {
        const p = join(d, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) out.push({ path: p, text: readFileSync(p, 'utf8') });
      }
    };
    walk(dir);
    return out;
  }

  const surfaces = [...sourcesUnder('src/render'), ...sourcesUnder('src/tui')];

  it('finds the surfaces to check', () => {
    expect(surfaces.length).toBeGreaterThan(3);
  });

  it.each(surfaces.map((f) => [f.path, f] as const))(
    '%s does no ad-hoc decimal arithmetic',
    (_label, file) => {
      // Dividing by 1e18 by hand is how two surfaces end up disagreeing about
      // what 1.5 QUAI looks like — and how a float creeps into a wei value.
      expect(file.text, 'use formatQuai/formatUnits from format/').not.toMatch(/1e18|10\s*\*\*\s*18/);
      expect(file.text, 'use formatQuai/formatUnits from format/').not.toMatch(/\.toFixed\(/);
    },
  );

  it.each(surfaces.map((f) => [f.path, f] as const))(
    '%s does not hand-roll an ellipsis truncation',
    (_label, file) => {
      // An address shortener in two places is two shorteners. format/ owns it,
      // and §7 forbids truncation entirely where a signature can follow.
      const handRolled = /\+\s*'…'|'…'\s*\+|\.\.\.'\s*\+/.test(file.text);
      expect(handRolled, 'use the shortener in format/').toBe(false);
    },
  );

  it('keeps sanitizeText out of render/ and tui/, where it would be too late', () => {
    for (const file of surfaces) {
      expect(file.text, `${file.path} should call safeText from format/`).not.toMatch(
        /from '@quaivault\/sdk'.*sanitizeText|sanitizeText.*from '@quaivault\/sdk'/s,
      );
    }
  });
});
