import type { Affordance, VaultTransaction } from '@quaivault/sdk';

/**
 * The TUI is a pure state machine; Ink is a thin projection of it.
 *
 * Everything worth testing lives here — navigation, selection, scrolling,
 * degraded state, and the fact that **the TUI never holds key material**. That
 * is testable with no terminal, which is why the reducer is the seam rather
 * than snapshotting frames (plan §6, Tier 6).
 */

export type Route = 'inbox' | 'detail';

export interface TuiRow {
  vault: string;
  vaultLabel: string;
  tx: VaultTransaction;
  affordances: Affordance[];
}

export interface PaneState {
  status: 'idle' | 'loading' | 'ok' | 'error' | 'degraded';
  error?: string;
  fetchedAt?: number;
}

export interface TuiState {
  route: Route;
  rows: TuiRow[];
  selected: number;
  scroll: number;
  viewport: number;
  pane: PaneState;
  /** Always false. The TUI delegates signing to a spawned one-shot process. */
  holdsKey: false;
  /** Set while a spawned signer is running. */
  signing: { hash: string; action: string } | null;
  lastSignResult: { ok: boolean; message: string } | null;
  quit: boolean;
}

export type TuiEvent =
  | { type: 'key'; key: string }
  | { type: 'resize'; rows: number }
  | { type: 'data'; rows: TuiRow[]; degraded: boolean; at: number }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'sign-start'; hash: string; action: string }
  | { type: 'sign-end'; ok: boolean; message: string };

export function initialState(viewport = 10): TuiState {
  return {
    route: 'inbox',
    rows: [],
    selected: 0,
    scroll: 0,
    viewport,
    pane: { status: 'idle' },
    holdsKey: false,
    signing: null,
    lastSignResult: null,
    quit: false,
  };
}

function clampScroll(state: TuiState): TuiState {
  const { selected, scroll, viewport } = state;
  let next = scroll;
  if (selected < scroll) next = selected;
  else if (selected >= scroll + viewport) next = selected - viewport + 1;
  next = Math.max(0, Math.min(next, Math.max(0, state.rows.length - viewport)));
  return next === scroll ? state : { ...state, scroll: next };
}

export function reduce(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'loading':
      return { ...state, pane: { ...state.pane, status: 'loading' } };

    case 'data': {
      const selected = Math.min(state.selected, Math.max(0, event.rows.length - 1));
      return clampScroll({
        ...state,
        rows: event.rows,
        selected,
        // "no results" and "cannot see results" are different things, and the
        // difference must survive a refresh.
        pane: { status: event.degraded ? 'degraded' : 'ok', fetchedAt: event.at },
      });
    }

    case 'error':
      return { ...state, pane: { status: 'error', error: event.message } };

    case 'resize':
      return clampScroll({ ...state, viewport: Math.max(1, event.rows) });

    case 'sign-start':
      // Signing happens in a spawned one-shot process. The TUI records that it
      // is happening; it never gains key material by doing so.
      return { ...state, signing: { hash: event.hash, action: event.action } };

    case 'sign-end':
      return {
        ...state,
        signing: null,
        lastSignResult: { ok: event.ok, message: event.message },
      };

    case 'key':
      return reduceKey(state, event.key);

    default: {
      const never: never = event;
      throw new Error(`unhandled tui event: ${JSON.stringify(never)}`);
    }
  }
}

function reduceKey(state: TuiState, key: string): TuiState {
  // While a spawned signer owns the terminal, the TUI ignores input entirely.
  if (state.signing) return state;

  switch (key) {
    case 'q':
      return state.route === 'detail' ? { ...state, route: 'inbox' } : { ...state, quit: true };
    case 'escape':
      return state.route === 'detail' ? { ...state, route: 'inbox' } : state;
    case 'j':
    case 'down':
      return clampScroll({
        ...state,
        selected: Math.min(state.selected + 1, Math.max(0, state.rows.length - 1)),
      });
    case 'k':
    case 'up':
      return clampScroll({ ...state, selected: Math.max(0, state.selected - 1) });
    case 'g':
      return clampScroll({ ...state, selected: 0 });
    case 'G':
      return clampScroll({ ...state, selected: Math.max(0, state.rows.length - 1) });
    case 'return':
    case 'l':
      return state.rows.length ? { ...state, route: 'detail' } : state;
    default:
      return state;
  }
}

export function selectedRow(state: TuiState): TuiRow | undefined {
  return state.rows[state.selected];
}

export function visibleRows(state: TuiState): TuiRow[] {
  return state.rows.slice(state.scroll, state.scroll + state.viewport);
}
