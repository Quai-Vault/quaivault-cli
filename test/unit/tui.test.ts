import { describe, expect, it } from 'vitest';
import {
  FORM_FIELDS,
  PANES,
  activeList,
  formArgv,
  initialForm,
  initialState,
  missingFields,
  reduce,
  selectedRow,
  visibleRows,
  ACTIVITY_LIMIT,
  type TuiEvent,
  type TuiRow,
  type TuiState,
} from '../../src/tui/reducer.js';
import { mapKey } from '../../src/tui/keys.js';
import { ADDR, fakeTx } from '../fake-client.js';

function rows(n: number): TuiRow[] {
  return Array.from({ length: n }, (_, i) => ({
    vault: ADDR.vault,
    vaultLabel: `v${i}`,
    tx: fakeTx({ hash: `0x${String(i).padStart(64, '0')}` }),
    affordances: [],
    batch: null,
  }));
}

function withRows(n: number, viewport = 5): TuiState {
  return reduce(initialState(viewport), { type: 'data', rows: rows(n), degraded: false, at: 0 });
}

function press(state: TuiState, ...keys: string[]): TuiState {
  return keys.reduce((s, key) => reduce(s, { type: 'key', key }), state);
}

describe('the TUI never holds key material', () => {
  it('starts with holdsKey false and no event can set it', () => {
    let s = initialState();
    expect(s.holdsKey).toBe(false);
    const events: TuiEvent[] = [
      { type: 'sign-start', hash: '0xabc', action: 'approve' },
      { type: 'sign-end', ok: true, message: 'done' },
      { type: 'key', key: 'a' },
      { type: 'data', rows: rows(3), degraded: false, at: 0 },
      { type: 'vaults', vaults: [{ address: ADDR.vault, label: 'v', pending: 1, hasRecovery: false }] },
    ];
    for (const e of events) {
      s = reduce(s, e);
      expect(s.holdsKey, e.type).toBe(false);
    }
  });

  it('records signing as in-flight without gaining a key', () => {
    const s = reduce(initialState(), { type: 'sign-start', hash: '0xabc', action: 'approve' });
    expect(s.signing).toEqual({ hash: '0xabc', action: 'approve' });
    expect(s.holdsKey).toBe(false);
  });

  it('ignores every keystroke while a spawned child owns the terminal', () => {
    const s = reduce(withRows(5), { type: 'sign-start', hash: '0xabc', action: 'approve' });
    for (const key of ['j', 'k', 'q', 'return', 'a', 'x', 'tab', 'escape']) {
      expect(reduce(s, { type: 'key', key }), key).toBe(s);
    }
  });
});

describe('pane navigation', () => {
  it('cycles every pane with tab and wraps', () => {
    let s = initialState();
    const seen = [s.pane];
    for (let i = 1; i < PANES.length; i++) {
      s = press(s, 'tab');
      seen.push(s.pane);
    }
    expect(seen).toEqual([...PANES]);
    expect(press(s, 'tab').pane).toBe(PANES[0]);
  });

  it('cycles backwards with shift-tab', () => {
    expect(press(initialState(), 'shift-tab').pane).toBe(PANES[PANES.length - 1]);
  });

  it('closes a detail overlay when switching pane', () => {
    const detail = press(withRows(3), 'return');
    expect(detail.detail).toBe(true);
    expect(press(detail, 'tab').detail).toBe(false);
  });

  it('navigates the list belonging to the active pane', () => {
    let s = withRows(3);
    s = reduce(s, { type: 'history', rows: rows(7) });
    expect(activeList(s)).toHaveLength(3);
    s = press(s, 'tab'); // → history
    expect(s.pane).toBe('history');
    expect(activeList(s)).toHaveLength(7);
  });

  it('has no list to navigate on the non-list panes', () => {
    let s = withRows(3);
    for (const pane of ['activity', 'vault', 'recovery'] as const) {
      s = { ...s, pane };
      expect(activeList(s), pane).toEqual([]);
      // Moving down on an empty list must not select past the end.
      expect(press(s, 'j').selected).toBe(0);
    }
  });
});

describe('list navigation', () => {
  it('moves with j/k and clamps at both ends', () => {
    let s = press(withRows(3), 'j');
    expect(s.selected).toBe(1);
    s = press(s, 'j', 'j');
    expect(s.selected).toBe(2);
    s = press(s, 'k', 'k', 'k', 'k', 'k');
    expect(s.selected).toBe(0);
  });

  it('scrolls the viewport to follow the selection', () => {
    let s = withRows(20, 5);
    for (let i = 0; i < 7; i++) s = press(s, 'j');
    expect(s.selected).toBe(7);
    expect(visibleRows(s)).toHaveLength(5);
    expect(visibleRows(s).map((r) => r.vaultLabel)).toContain('v7');
  });

  it('jumps to the ends with g and G', () => {
    let s = press(withRows(20, 5), 'G');
    expect(s.selected).toBe(19);
    s = press(s, 'g');
    expect(s.selected).toBe(0);
    expect(s.scroll).toBe(0);
  });

  it('opens and closes the detail overlay', () => {
    let s = press(withRows(3), 'return');
    expect(s.detail).toBe(true);
    expect(selectedRow(s)).toBeTruthy();
    s = press(s, 'q');
    expect(s.detail).toBe(false);
    expect(s.quit).toBe(false);
  });

  it('quits from a pane but not from a detail overlay', () => {
    const detail = press(withRows(3), 'return');
    expect(press(detail, 'q').quit).toBe(false);
    expect(press(withRows(3), 'q').quit).toBe(true);
  });

  it('cannot open a detail overlay when there is nothing to open', () => {
    expect(press(initialState(), 'return').detail).toBe(false);
  });
});

describe('resize', () => {
  it('clamps scroll so the selection stays visible', () => {
    let s = press(withRows(20, 10), 'G');
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
    expect(empty.load.status).toBe('ok');
    expect(blind.load.status).toBe('degraded');
  });

  it('keeps the selection in range when the list shrinks under it', () => {
    let s = press(withRows(10, 5), 'G');
    expect(s.selected).toBe(9);
    s = reduce(s, { type: 'data', rows: rows(2), degraded: false, at: 2 });
    expect(s.selected).toBe(1);
    expect(selectedRow(s)).toBeTruthy();
  });
});

describe('activity feed', () => {
  it('prepends newest first and stays bounded', () => {
    let s = initialState();
    for (let i = 0; i < ACTIVITY_LIMIT + 25; i++) {
      s = reduce(s, {
        type: 'activity',
        entry: { at: i, topic: 'transactions', type: 'INSERT', vault: ADDR.vault },
      });
    }
    expect(s.activity).toHaveLength(ACTIVITY_LIMIT);
    expect(s.activity[0]?.at).toBe(ACTIVITY_LIMIT + 24);
  });
});

describe('the propose form', () => {
  const form = (): TuiState => ({ ...initialState(), pane: 'propose' });

  it('starts on the kind selector and picks kinds with left/right', () => {
    let s = form();
    expect(s.form.field).toBe(-1);
    expect(s.form.kind).toBe('transfer');
    s = press(s, 'right');
    expect(s.form.kind).toBe('token');
    s = press(s, 'left');
    expect(s.form.kind).toBe('transfer');
  });

  it('types printable characters into the focused field', () => {
    let s = press(form(), 'down'); // into the first field
    s = press(s, '0', 'x', 'a', 'b');
    expect(s.form.values.to).toBe('0xab');
  });

  it('never types a control gesture into a field', () => {
    // The reducer only accepts single printable characters; named keys are
    // commands. A literal tab landing in an address field would be invisible
    // and would corrupt the argv we hand to the child.
    let s = press(form(), 'down', '0', 'x');
    // escape is excluded on purpose — it legitimately leaves the form, and
    // that is asserted separately.
    for (const key of ['tab', 'shift-tab', 'up', 'down', 'left', 'right']) {
      s = reduce(s, { type: 'key', key });
    }
    expect(s.form.values.to).toBe('0x');
  });

  it('deletes with backspace and clears with ctrl-u', () => {
    let s = press(form(), 'down', 'a', 'b', 'c');
    s = press(s, 'backspace');
    expect(s.form.values.to).toBe('ab');
    s = press(s, 'ctrl-u');
    expect(s.form.values.to).toBe('');
  });

  it('quits from the kind selector, rather than swallowing q', () => {
    // Found by running it: `propose` is last in the tab order, so a form that
    // eats q and tab is a pane you can enter and never leave.
    expect(press(form(), 'q').quit).toBe(true);
  });

  it('still refreshes and cycles panes from the kind selector', () => {
    expect(press(form(), 'shift-tab').pane).toBe('recovery');
  });

  it('does not quit while a field is being typed into', () => {
    // Once you are editing, q is a character.
    const s = press(form(), 'down', 'q');
    expect(s.quit).toBe(false);
    expect(s.form.values.to).toBe('q');
  });

  it('leaves the pane with tab while the kind selector is focused', () => {
    // Otherwise `propose`, last in the tab order, is a pane you can enter and
    // never tab out of.
    const s = press(form(), 'tab');
    expect(s.pane).toBe('inbox');
  });

  it('walks fields with tab and stops at the last one', () => {
    let s = press(form(), 'down');
    const count = FORM_FIELDS.transfer.length;
    for (let i = 0; i < count + 5; i++) s = press(s, 'tab');
    expect(s.form.field).toBe(count - 1);
  });

  it('escape always leaves the form rather than trapping the user', () => {
    const s = press(form(), 'down', 'a', 'escape');
    expect(s.pane).toBe('inbox');
    expect(s.form.values.to).toBeUndefined();
  });

  it('switching kind resets the values so stale fields cannot leak across', () => {
    // A `token` address left over from a previous kind must not survive into
    // a `transfer`, where it would silently become the recipient.
    let s = press(form(), 'down', 'a', 'b');
    s = press(s, 'up', 'right');
    expect(s.form.kind).toBe('token');
    expect(s.form.values).toEqual({});
  });
});

describe('formArgv — the security boundary', () => {
  const filled = (kind: 'transfer' | 'token' | 'add-owner' | 'threshold', values: Record<string, string>) => ({
    ...initialForm(kind),
    values,
  });

  it('refuses to build until every required field is present', () => {
    expect(formArgv(filled('transfer', {}), ADDR.vault)).toBeNull();
    expect(formArgv(filled('transfer', { to: ADDR.bob }), ADDR.vault)).toBeNull();
    expect(missingFields(filled('transfer', { to: ADDR.bob }))).toEqual(['amount']);
  });

  it('builds a transfer as flags, never as calldata', () => {
    const argv = formArgv(filled('transfer', { to: ADDR.bob, amount: '1.5' }), ADDR.vault);
    expect(argv).toEqual(['propose', 'transfer', ADDR.vault, '--to', ADDR.bob, '--amount', '1.5']);
    // The whole point: nothing here is *encoded*. Addresses are hex, but no
    // argument may be a hex blob longer than an address — that would mean the
    // TUI had built calldata, which is the child's job precisely so the child
    // can re-read chain state and show its own §7 disclosure first.
    for (const arg of argv!) {
      if (arg.startsWith('0x')) expect(arg.length, arg).toBeLessThanOrEqual(42);
    }
    expect(argv).not.toContain('--data');
  });

  it('builds each kind with the flags its command actually takes', () => {
    expect(formArgv(filled('token', { token: ADDR.token, to: ADDR.bob, amount: '42' }), ADDR.vault)).toEqual(
      ['propose', 'token', ADDR.vault, '--token', ADDR.token, '--to', ADDR.bob, '--amount', '42'],
    );
    expect(formArgv(filled('add-owner', { owner: ADDR.carol }), ADDR.vault)).toEqual([
      'propose',
      'add-owner',
      ADDR.vault,
      ADDR.carol,
    ]);
    expect(formArgv(filled('threshold', { threshold: '3' }), ADDR.vault)).toEqual([
      'propose',
      'threshold',
      ADDR.vault,
      '3',
    ]);
  });

  it('appends timing flags only when given', () => {
    const bare = formArgv(filled('transfer', { to: ADDR.bob, amount: '1' }), ADDR.vault)!;
    expect(bare).not.toContain('--expiration');
    const timed = formArgv(
      filled('transfer', { to: ADDR.bob, amount: '1', expiration: '7d', executionDelay: '24h' }),
      ADDR.vault,
    )!;
    expect(timed).toContain('--expiration');
    expect(timed[timed.indexOf('--expiration') + 1]).toBe('7d');
    expect(timed[timed.indexOf('--execution-delay') + 1]).toBe('24h');
  });

  it('trims whitespace so a stray space cannot become part of an address', () => {
    const argv = formArgv(filled('transfer', { to: `  ${ADDR.bob}  `, amount: ' 1 ' }), ADDR.vault)!;
    expect(argv).toContain(ADDR.bob);
    expect(argv).toContain('1');
  });

  it('treats a whitespace-only required field as missing', () => {
    expect(formArgv(filled('transfer', { to: '   ', amount: '1' }), ADDR.vault)).toBeNull();
  });
});

describe('mapKey', () => {
  it('prefers named keys over their character codes', () => {
    // Ink reports tab with input '\t'; without this a form would type a
    // literal tab into a field.
    expect(mapKey('\t', { tab: true })).toBe('tab');
    expect(mapKey('\t', { tab: true, shift: true })).toBe('shift-tab');
    expect(mapKey('\r', { return: true })).toBe('return');
    expect(mapKey('', { escape: true })).toBe('escape');
  });

  it('maps arrows and editing keys', () => {
    expect(mapKey('', { upArrow: true })).toBe('up');
    expect(mapKey('', { downArrow: true })).toBe('down');
    expect(mapKey('', { leftArrow: true })).toBe('left');
    expect(mapKey('', { rightArrow: true })).toBe('right');
    expect(mapKey('', { backspace: true })).toBe('backspace');
    expect(mapKey('', { delete: true })).toBe('backspace');
    expect(mapKey('u', { ctrl: true })).toBe('ctrl-u');
  });

  it('passes printable characters through and drops everything else', () => {
    expect(mapKey('a', {})).toBe('a');
    expect(mapKey('7', {})).toBe('7');
    expect(mapKey(' ', {})).toBe(' ');
    // An unhandled control chord must never reach a text field.
    expect(mapKey('c', { ctrl: true })).toBeNull();
    expect(mapKey('', {})).toBeNull();
    expect(mapKey('ab', {})).toBeNull();
  });
});
