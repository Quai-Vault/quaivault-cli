import { describe, expect, it } from 'vitest';
import { renderToString } from 'ink';
import {
  ActivityPane,
  DetailPane,
  HistoryPane,
  InboxPane,
  ProposePane,
  RecoveryPane,
  VaultPane,
  BADGE_RESERVE,
} from '../../src/tui/panes.js';
import { abiSourceBadge } from '../../src/format/index.js';
import type { TuiEnv } from '../../src/tui/env.js';
import { initialState, reduce, type TuiRow, type TuiState } from '../../src/tui/reducer.js';
import { analyzeBatch } from '../../src/abi/batch.js';
import { ADDR, batchWithDelegatecall, fakeTx, unreadableBatch } from '../fake-client.js';
import { mainnet } from '@quaivault/sdk';

/**
 * Ink smoke tests (plan §6, Tier 6: "~10 Ink smoke tests, **no full-frame
 * snapshots**").
 *
 * Rendered through Ink's own `renderToString`, which avoids taking
 * `ink-testing-library` as a second test dependency. Assertions are on the
 * facts a reviewer must be able to see — the delegatecall warning, the full
 * recipient address, the provenance badge — never on the whole frame, because
 * a full-frame snapshot fails on every cosmetic change and gets regenerated
 * without being read.
 */

const env: TuiEnv = {
  identity: ADDR.alice,
  contactName: (a) => (a.toLowerCase() === ADDR.bob.toLowerCase() ? 'bob' : undefined),
  now: () => 1_800_000_000,
  width: 100,
};

function row(over: Partial<TuiRow> = {}): TuiRow {
  return {
    vault: ADDR.vault,
    vaultLabel: 'treasury',
    tx: fakeTx(),
    affordances: [],
    batch: null,
    ...over,
  };
}

function withRows(rows: TuiRow[]): TuiState {
  return reduce(initialState(10), { type: 'data', rows, degraded: false, at: 0 });
}

/** Strip SGR colour codes so assertions read the text, not the escapes. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI, '');

describe('InboxPane', () => {
  it('renders a row with its hash, approvals and summary', () => {
    const out = strip(renderToString(<InboxPane state={withRows([row()])} env={env} />));
    expect(out).toContain('treasury');
    expect(out).toContain(fakeTx().hash.slice(2, 10));
    expect(out).toContain('1/2');
  });

  it('says "cannot see" rather than "none" when the indexer is down', () => {
    const degraded = reduce(initialState(10), {
      type: 'data',
      rows: [],
      degraded: true,
      at: 0,
    });
    const out = strip(renderToString(<InboxPane state={degraded} env={env} />));
    expect(out).toMatch(/Cannot see/);
    expect(out).not.toMatch(/Nothing waiting/);
  });

  it('says "nothing waiting" when the list is genuinely empty', () => {
    const out = strip(renderToString(<InboxPane state={withRows([])} env={env} />));
    expect(out).toMatch(/Nothing waiting/);
  });

  it('badges a non-builtin decode and leaves builtin unbadged', () => {
    const guessed = strip(
      renderToString(<InboxPane state={withRows([row({ tx: fakeTx({ abiSource: 'heuristic' }) })])} env={env} />),
    );
    const verified = strip(
      renderToString(<InboxPane state={withRows([row({ tx: fakeTx({ abiSource: 'builtin' }) })])} env={env} />),
    );
    expect(guessed).toMatch(/guessed/);
    expect(verified).not.toMatch(/guessed/);
  });
});

describe('DetailPane', () => {
  it('shows the full recipient, never a shortened one', () => {
    const out = strip(renderToString(<DetailPane row={row()} env={env} />));
    // The disclosed fields must be untruncated (§7). The *summary* line may
    // contain the SDK's own shortened form — that is attacker-influenced
    // prose, which is why it is listed under `untrusted` and why the To line
    // exists separately.
    const toLine = out.split('\n').find((l) => l.trimStart().startsWith('To'));
    expect(toLine).toBeTruthy();
    expect(toLine).toContain(ADDR.alice);
    expect(toLine).not.toContain('…');
    for (const line of out.split('\n').filter((l) => l.includes('[x]') || l.includes('[ ]'))) {
      expect(line).not.toContain('…');
    }
  });

  it('resolves a contact name alongside the address', () => {
    const tx = fakeTx({ to: ADDR.bob });
    const out = strip(renderToString(<DetailPane row={row({ tx })} env={env} />));
    expect(out).toContain(ADDR.bob);
    expect(out).toContain('bob');
  });

  it('shows the value in both QUAI and exact wei', () => {
    const tx = fakeTx({ value: 1_500_000_000_000_000_000n });
    const out = strip(renderToString(<DetailPane row={row({ tx })} env={env} />));
    expect(out).toContain('1.5 QUAI');
    expect(out).toContain('1500000000000000000 wei');
  });

  it('warns loudly about a delegatecall inside a batch', () => {
    // The only place a delegatecall can be seen at all (§7) — and the TUI is
    // a surface a reviewer may approve from.
    const tx = fakeTx({ data: batchWithDelegatecall(), kind: 'batched_call' });
    const batch = analyzeBatch({
      vault: ADDR.vault,
      to: mainnet.contracts.multiSendCallOnly!,
      data: tx.data,
      contracts: mainnet.contracts,
    });
    const out = strip(renderToString(<DetailPane row={row({ tx, batch })} env={env} />));
    expect(out).toContain('DELEGATECALL');
    expect(out).toMatch(/rewrite vault storage/);
  });

  it('says a batch is unreadable rather than showing a partial one', () => {
    const tx = fakeTx({ data: unreadableBatch(), kind: 'batched_call' });
    const batch = analyzeBatch({
      vault: ADDR.vault,
      to: mainnet.contracts.multiSendCallOnly!,
      data: tx.data,
      contracts: mainnet.contracts,
    });
    const out = strip(renderToString(<DetailPane row={row({ tx, batch })} env={env} />));
    expect(out).toContain('UNREADABLE');
  });

  it('renders raw calldata when the ABI is unknown', () => {
    const tx = fakeTx({ abiSource: 'none', data: `0xdeadbeef${'11'.repeat(32)}` });
    const out = strip(renderToString(<DetailPane row={row({ tx })} env={env} />));
    expect(out).toContain('unknown ABI');
    expect(out).toContain('0xdeadbeef');
  });
});

describe('VaultPane and RecoveryPane', () => {
  it('lists owners and the threshold', () => {
    const state: TuiState = {
      ...initialState(10),
      vaultDetail: {
        owners: [ADDR.alice, ADDR.bob],
        threshold: 2,
        minExecutionDelay: 3600,
        modules: [],
        balanceWei: 1_000_000_000_000_000_000n,
      },
    };
    const out = strip(renderToString(<VaultPane state={state} env={env} />));
    expect(out).toContain('2 of 2 owners');
    expect(out).toContain(ADDR.alice);
    expect(out).toContain('1 QUAI');
  });

  it('reports no recovery in the affirmative, not as an empty pane', () => {
    const out = strip(renderToString(<RecoveryPane state={initialState(10)} env={env} />));
    expect(out).toMatch(/No recovery pending/);
  });

  it('states plainly that a pending recovery replaces the owner set', () => {
    const state: TuiState = {
      ...initialState(10),
      recovery: {
        hash: `0x${'re'.repeat(32)}`,
        newOwners: [ADDR.carol],
        newThreshold: 1,
        approvals: 2,
        required: 3,
        executableAt: 1_800_003_600,
      },
    };
    const out = strip(renderToString(<RecoveryPane state={state} env={env} />));
    expect(out).toMatch(/replaces the entire owner set/);
    expect(out).toContain('2 of 3 guardians');
    expect(out).toContain(ADDR.carol);
  });
});

describe('ActivityPane and HistoryPane', () => {
  it('invites the user to wait rather than showing an empty box', () => {
    const out = strip(renderToString(<ActivityPane state={initialState(10)} env={env} />));
    expect(out).toMatch(/fills as the chain moves/);
  });

  it('lists events newest first', () => {
    let state = initialState(10);
    for (const topic of ['owners', 'transactions']) {
      state = reduce(state, {
        type: 'activity',
        entry: { at: 1_800_000_000, topic, type: 'INSERT', vault: ADDR.vault },
      });
    }
    const out = strip(renderToString(<ActivityPane state={state} env={env} />));
    expect(out.indexOf('transactions')).toBeLessThan(out.indexOf('owners'));
  });

  it('shows a transaction status in history', () => {
    const state = reduce(initialState(10), {
      type: 'history',
      rows: [row({ tx: fakeTx({ status: 'executed' }) })],
    });
    const out = strip(renderToString(<HistoryPane state={{ ...state, pane: 'history' }} env={env} />));
    expect(out).toContain('executed');
  });
});

describe('ProposePane', () => {
  it('shows every kind with one selected', () => {
    const out = strip(renderToString(<ProposePane state={{ ...initialState(10), pane: 'propose' }} />));
    expect(out).toContain('transfer');
    expect(out).toContain('token');
    expect(out).toContain('add-owner');
    expect(out).toContain('(•)');
  });

  it('lists what is still missing rather than silently refusing', () => {
    const out = strip(renderToString(<ProposePane state={{ ...initialState(10), pane: 'propose' }} />));
    expect(out).toMatch(/needs: to, amount/);
  });

  it('promises the disclosure once the form is complete', () => {
    // The user must know that pressing enter does not sign anything.
    const state: TuiState = {
      ...initialState(10),
      pane: 'propose',
      form: { kind: 'transfer', field: 1, values: { to: ADDR.bob, amount: '1' } },
    };
    const out = strip(renderToString(<ProposePane state={state} />));
    expect(out).toMatch(/re-reads the chain/);
    expect(out).toMatch(/before anything is signed/);
  });
});

/**
 * Column alignment.
 *
 * Guards a real regression: adjacent JSX expressions drop the separator space
 * (`{pad(x, 12)} ` is trimmed before a newline), which slid every column after
 * the first one column left and left the header pointing at the wrong data.
 * A table whose header does not line up with its rows is worse than no header.
 */
describe('list panes line their columns up with the header', () => {
  // Ink's `renderToString` lays out at 80 columns, so the pane must be told
  // the same width or every row wraps and the assertions measure nothing.
  const env80: TuiEnv = { ...env, width: 80 };

  function lines(node: React.ReactElement): string[] {
    return strip(renderToString(node)).split('\n').filter((l) => l.trim() !== '');
  }

  /**
   * The inbox reserves a fixed number of columns for the badge. If a badge
   * ever outgrows it the row silently wraps, so pin the assumption here rather
   * than discovering it against a heuristically-decoded transaction.
   */
  it('reserves enough width for the longest provenance badge', () => {
    for (const source of ['builtin', 'supplied', 'heuristic', 'none'] as const) {
      expect(abiSourceBadge(source).text.length + 1).toBeLessThanOrEqual(BADGE_RESERVE);
    }
  });

  it('inbox rows start each column where the header says they do', () => {
    const state = reduce(initialState(10), {
      type: 'data',
      rows: [
        row({ tx: fakeTx({ hash: `0x${'ab'.repeat(32)}`, summary: 'send 1 QUAI' }) }),
        row({ vaultLabel: 'ops-multisig', tx: fakeTx({ hash: `0x${'cd'.repeat(32)}`, summary: 'addOwner' }) }),
      ],
      degraded: false,
      at: 0,
    });
    const [head, first, second] = lines(<InboxPane state={state} env={env80} />);

    expect(head).toBeDefined();
    const vaultAt = head!.indexOf('VAULT');
    const txAt = head!.indexOf('TX');
    const apprAt = head!.indexOf('APPR');
    const summaryAt = head!.indexOf('SUMMARY');

    // The selected row carries a marker; the unselected one does not. Both
    // must still place their cells under the header.
    expect(first!.indexOf('treasury')).toBe(vaultAt);
    expect(first!.indexOf('abababab')).toBe(txAt);
    expect(first!.slice(apprAt).startsWith('1/2')).toBe(true);
    expect(first!.indexOf('send 1 QUAI')).toBe(summaryAt);

    expect(second!.indexOf('ops-multisig')).toBe(vaultAt);
    expect(second!.indexOf('cdcdcdcd')).toBe(txAt);
    expect(second!.indexOf('addOwner')).toBe(summaryAt);
  });

  it('a long summary is truncated rather than wrapped onto a second line', () => {
    const state = reduce(initialState(10), {
      type: 'data',
      rows: [row({ tx: fakeTx({ summary: 'x'.repeat(400) }) })],
      degraded: false,
      at: 0,
    });
    // Header plus exactly one row. A wrapped row desynchronizes the rendered
    // list from `viewport` and pushes the last transaction off a fixed-height
    // screen.
    expect(lines(<InboxPane state={state} env={env80} />)).toHaveLength(2);
  });
});
