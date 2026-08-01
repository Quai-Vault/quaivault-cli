import { describe, expect, it } from 'vitest';
import {
  initialState,
  reduce,
  selectedRow,
  visibleRows,
  type TuiRow,
  type TuiState,
} from '../../src/tui/reducer.js';
import { ADDR, fakeTx } from '../fake-client.js';

function rows(n: number): TuiRow[] {
  return Array.from({ length: n }, (_, i) => ({
    vault: ADDR.vault,
    vaultLabel: `v${i}`,
    tx: fakeTx({ hash: `0x${String(i).padStart(64, '0')}` }),
    affordances: [],
  }));
}

function withRows(n: number, viewport = 5): TuiState {
  return reduce(initialState(viewport), { type: 'data', rows: rows(n), degraded: false, at: 0 });
}

describe('the TUI never holds key material', () => {
  it('starts with holdsKey false and no event can set it', () => {
    let s = initialState();
    expect(s.holdsKey).toBe(false);
    const events = [
      { type: 'sign-start', hash: '0xabc', action: 'approve' },
      { type: 'sign-end', ok: true, message: 'done' },
      { type: 'key', key: 'a' },
      { type: 'data', rows: rows(3), degraded: false, at: 0 },
    ] as const;
    for (const e of events) {
      s = reduce(s, e);
      expect(s.holdsKey, e.type).toBe(false);
    }
  });

  it('records signing as in-flight without gaining a key', () => {
    // Signing happens in a spawned one-shot process; this is only bookkeeping.
    const s = reduce(initialState(), { type: 'sign-start', hash: '0xabc', action: 'approve' });
    expect(s.signing).toEqual({ hash: '0xabc', action: 'approve' });
    expect(s.holdsKey).toBe(false);
  });

  it('ignores every keystroke while a spawned signer owns the terminal', () => {
    const s = reduce(withRows(5), { type: 'sign-start', hash: '0xabc', action: 'approve' });
    for (const key of ['j', 'k', 'q', 'return', 'a', 'x']) {
      expect(reduce(s, { type: 'key', key })).toBe(s);
    }
  });
});

describe('navigation', () => {
  it('moves with j/k and clamps at both ends', () => {
    let s = withRows(3);
    s = reduce(s, { type: 'key', key: 'j' });
    expect(s.selected).toBe(1);
    s = reduce(s, { type: 'key', key: 'j' });
    s = reduce(s, { type: 'key', key: 'j' });
    expect(s.selected).toBe(2);
    for (let i = 0; i < 5; i++) s = reduce(s, { type: 'key', key: 'k' });
    expect(s.selected).toBe(0);
  });

  it('scrolls the viewport to follow the selection', () => {
    let s = withRows(20, 5);
    for (let i = 0; i < 7; i++) s = reduce(s, { type: 'key', key: 'j' });
    expect(s.selected).toBe(7);
    expect(visibleRows(s)).toHaveLength(5);
    expect(visibleRows(s).map((r) => r.vaultLabel)).toContain('v7');
  });

  it('jumps to the ends with g and G', () => {
    let s = withRows(20, 5);
    s = reduce(s, { type: 'key', key: 'G' });
    expect(s.selected).toBe(19);
    s = reduce(s, { type: 'key', key: 'g' });
    expect(s.selected).toBe(0);
    expect(s.scroll).toBe(0);
  });

  it('opens and closes the detail view', () => {
    let s = withRows(3);
    s = reduce(s, { type: 'key', key: 'return' });
    expect(s.route).toBe('detail');
    expect(selectedRow(s)).toBeTruthy();
    s = reduce(s, { type: 'key', key: 'q' });
    expect(s.route).toBe('inbox');
    expect(s.quit).toBe(false);
  });

  it('quits from the inbox but not from a detail view', () => {
    const detail = reduce(withRows(3), { type: 'key', key: 'return' });
    expect(reduce(detail, { type: 'key', key: 'q' }).quit).toBe(false);
    expect(reduce(withRows(3), { type: 'key', key: 'q' }).quit).toBe(true);
  });

  it('cannot open a detail view when there is nothing to open', () => {
    const s = reduce(initialState(), { type: 'key', key: 'return' });
    expect(s.route).toBe('inbox');
  });
});

describe('resize', () => {
  it('clamps scroll so the selection stays visible', () => {
    let s = withRows(20, 10);
    s = reduce(s, { type: 'key', key: 'G' });
    s = reduce(s, { type: 'resize', rows: 3 });
    expect(s.viewport).toBe(3);
    expect(s.selected).toBeGreaterThanOrEqual(s.scroll);
    expect(s.selected).toBeLessThan(s.scroll + s.viewport);
  });

  it('never allows a zero-height viewport', () => {
    expect(reduce(initialState(), { type: 'resize', rows: 0 }).viewport).toBe(1);
  });
});

describe('degraded state survives a refresh', () => {
  it('distinguishes "no results" from "cannot see results"', () => {
    const empty = reduce(initialState(), { type: 'data', rows: [], degraded: false, at: 1 });
    const blind = reduce(initialState(), { type: 'data', rows: [], degraded: true, at: 1 });
    expect(empty.rows).toHaveLength(0);
    expect(blind.rows).toHaveLength(0);
    // Same row count, different meaning — and the difference is in the state.
    expect(empty.pane.status).toBe('ok');
    expect(blind.pane.status).toBe('degraded');
  });

  it('keeps the selection in range when the list shrinks under it', () => {
    let s = withRows(10, 5);
    s = reduce(s, { type: 'key', key: 'G' });
    expect(s.selected).toBe(9);
    s = reduce(s, { type: 'data', rows: rows(2), degraded: false, at: 2 });
    expect(s.selected).toBe(1);
    expect(selectedRow(s)).toBeTruthy();
  });
});

describe('sign outcome', () => {
  it('clears the in-flight marker and records the result', () => {
    let s = reduce(withRows(3), { type: 'sign-start', hash: '0xabc', action: 'approve' });
    s = reduce(s, { type: 'sign-end', ok: false, message: 'refused by policy' });
    expect(s.signing).toBeNull();
    expect(s.lastSignResult).toEqual({ ok: false, message: 'refused by policy' });
  });
});
