import { Box, Text, useApp, useInput, useStdout, useWindowSize } from 'ink';
import { useEffect, useReducer, useRef } from 'react';
import { safeText } from '../format/index.js';
import type { TuiEnv } from './env.js';
import { mapKey } from './keys.js';
import {
  PANES,
  formArgv,
  initialState,
  reduce,
  selectedRow,
  selectedVault,
  type Pane,
  type TuiEvent,
  type TuiState,
} from './reducer.js';
import {
  ActivityPane,
  DetailPane,
  HistoryPane,
  InboxPane,
  ProposePane,
  RecoveryPane,
  VaultPane,
} from './panes.js';

/**
 * The Ink projection (plan §4.4).
 *
 * The app holds **no key and no client**. It receives a `TuiEnv` — display
 * helpers and nothing else — and every action leaves through `onSpawn`, which
 * hands argv to a fresh one-shot process that reads its own password from
 * `/dev/tty`. That makes "the TUI can do nothing the one-shot surface cannot"
 * structural rather than a convention someone has to remember.
 */

export interface AppProps {
  env: TuiEnv;
  /** Initial state, so the caller can seed a viewport. */
  seed?: TuiState;
  /** Re-read everything. */
  onRefresh: (dispatch: (event: TuiEvent) => void) => Promise<void>;
  /**
   * Re-read only the vault-scoped panes, for a new vault. Optional so tests
   * can render the tree without a data layer.
   */
  onSelectVault?: (dispatch: (event: TuiEvent) => void, address: string) => Promise<void>;
  /**
   * Hand the terminal to a one-shot child. The caller suspends Ink first, so
   * the child owns stdin and stdout while it runs.
   */
  onSpawn: (argv: string[]) => Promise<{ ok: boolean; message: string }>;
  /** Subscribe to change-feed events; returns an unsubscribe. */
  onSubscribe?: (dispatch: (event: TuiEvent) => void) => () => void;
}

const PANE_LABEL: Record<Pane, string> = {
  inbox: 'inbox',
  history: 'history',
  activity: 'activity',
  vault: 'vault',
  recovery: 'recovery',
  propose: 'propose',
};

/**
 * Rows the chrome costs: header, tab bar, both content borders, the table's
 * column header, and two footer lines, plus one of slack.
 *
 * The viewport is derived from this rather than guessed. Overshooting pushes
 * list rows past the bottom of a fixed-height layout, where they are not
 * merely ugly — a row you cannot see is a transaction you do not know is
 * waiting.
 */
export const CHROME_ROWS = 9;

export function App({
  env,
  seed,
  onRefresh,
  onSelectVault,
  onSpawn,
  onSubscribe,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  const [state, dispatch] = useReducer(reduce, seed ?? initialState());
  // While a child owns the terminal we must not act on input at all.
  const busy = useRef(false);

  const rows = size.rows || stdout?.rows || 24;
  const width = size.columns || stdout?.columns || 100;

  // Resize. The reducer has always had this event; nothing ever emitted it,
  // so the viewport was fixed at whatever the terminal was on launch.
  useEffect(() => {
    dispatch({ type: 'resize', rows: Math.max(3, rows - CHROME_ROWS) });
  }, [rows]);

  useEffect(() => {
    void onRefresh(dispatch);
    return onSubscribe?.(dispatch);
  }, [onRefresh, onSubscribe]);

  /**
   * The vault cursor moved, so the scoped panes are about to describe a
   * different vault. The reducer has already blanked them; this fetches.
   *
   * The first address is *not* fetched here — `onRefresh` already loaded it,
   * and firing both would double every read on startup.
   */
  const vaultAddress = selectedVault(state)?.address;
  const lastVault = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!vaultAddress) return;
    if (lastVault.current === undefined || lastVault.current === vaultAddress) {
      lastVault.current = vaultAddress;
      return;
    }
    lastVault.current = vaultAddress;
    void onSelectVault?.(dispatch, vaultAddress);
  }, [vaultAddress, onSelectVault]);

  useEffect(() => {
    if (state.quit) exit();
  }, [state.quit, exit]);

  useInput((input, key) => {
    if (busy.current) return;
    const mapped = mapKey(input, key);
    if (mapped === null) return;

    const row = selectedRow(state);
    const vault = selectedVault(state);

    /** Everything that changes the chain leaves the process here. */
    const spawn = (argv: string[], action: string, hash: string): void => {
      busy.current = true;
      dispatch({ type: 'sign-start', hash, action });
      void onSpawn(argv)
        .then((outcome) => {
          dispatch({ type: 'sign-end', ok: outcome.ok, message: outcome.message });
          return onRefresh(dispatch);
        })
        .finally(() => {
          busy.current = false;
        });
    };

    if (state.pane === 'propose' && mapped === 'return' && state.form.field >= 0 && vault) {
      const argv = formArgv(state.form, vault.address);
      if (argv) {
        spawn(argv, 'propose', '');
        return;
      }
    }

    if (state.detail && row) {
      const can = (a: string): boolean => row.affordances.some((x) => x.action === a && x.allowed);
      if (mapped === 'a' && can('approve')) {
        spawn(['tx', 'approve', row.vault, row.tx.hash], 'approve', row.tx.hash);
        return;
      }
      if (mapped === 'x' && can('execute')) {
        spawn(['tx', 'execute', row.vault, row.tx.hash], 'execute', row.tx.hash);
        return;
      }
    }

    /**
     * Recovery is the guardian's surface, and a guardian may be an owner of
     * nothing — so approve and execute have to live here rather than only on
     * the transaction detail overlay, which is reached through a list a
     * guardian-only identity has no rows in.
     *
     * `c` stays first in the footer: cancelling is the defensive action, and
     * the one a compromised-key holder needs to reach fastest.
     */
    if (state.pane === 'recovery' && state.recovery && vault && !state.detail) {
      const hash = state.recovery.hash;
      if (mapped === 'c') {
        spawn(['recovery', 'cancel', vault.address, hash], 'recovery cancel', hash);
        return;
      }
      if (mapped === 'a') {
        spawn(['recovery', 'approve', vault.address, hash], 'recovery approve', hash);
        return;
      }
      if (mapped === 'x') {
        spawn(['recovery', 'execute', vault.address, hash], 'recovery execute', hash);
        return;
      }
    }

    if (mapped === 'r' && state.pane !== 'propose') {
      void onRefresh(dispatch);
      return;
    }

    dispatch({ type: 'key', key: mapped });
  });

  const envWithWidth: TuiEnv = { ...env, width };

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Header state={state} env={envWithWidth} />
      <Tabs state={state} />
      <Box
        flexGrow={1}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Body state={state} env={envWithWidth} />
      </Box>
      <Footer state={state} />
    </Box>
  );
}

/**
 * The identity bar.
 *
 * The vault selector is here rather than in a pane because it scopes four of
 * the six panes — history, vault, recovery and the propose form all read it.
 * It shows position (`2/5`) so "this is one of several" is legible without
 * cycling, and it renders even for a single vault so the surface does not
 * change shape when a second one appears.
 */
function Header({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const vault = selectedVault(state);
  const alarm = state.vaults.some((v) => v.hasRecovery);
  const many = state.vaults.length > 1;
  return (
    <Box>
      <Text bold color="cyan">
        QuaiVault
      </Text>
      <Text dimColor> {env.identity}</Text>
      {vault ? (
        <>
          <Text dimColor> · </Text>
          {many ? <Text dimColor>‹ </Text> : null}
          <Text bold>{safeText(vault.label, 24)}</Text>
          {vault.pending > 0 ? <Text color="yellow"> {vault.pending}</Text> : null}
          {many ? (
            <Text dimColor>
              {' '}
              › {state.selectedVault + 1}/{state.vaults.length}
            </Text>
          ) : null}
        </>
      ) : null}
      {state.load.status === 'degraded' ? (
        <Text color="red"> · indexer unavailable — lists are incomplete, not empty</Text>
      ) : null}
      {alarm ? (
        <Text color="red" bold>
          {'  ⚠ RECOVERY PENDING'}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * The menu bar, visually distinct from content.
 *
 * The active pane is reverse-video rather than merely coloured: on the many
 * terminals where `dimColor` is a no-op, colour alone left every tab looking
 * identical and there was no way to tell which pane you were in.
 */
function Tabs({ state }: { state: TuiState }): React.ReactElement {
  return (
    <Box>
      {PANES.map((p, i) => (
        <Box key={p}>
          {i > 0 ? <Text dimColor>│</Text> : null}
          {p === state.pane ? (
            <Text inverse bold color="cyan">
              {` ${PANE_LABEL[p]} `}
            </Text>
          ) : (
            <Text dimColor>{` ${PANE_LABEL[p]} `}</Text>
          )}
        </Box>
      ))}
    </Box>
  );
}

function Body({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  if (state.signing) {
    return (
      <Text color="yellow">
        running {state.signing.action} in a separate process — it reads its own password and shows
        you the transaction before signing
      </Text>
    );
  }
  if (state.detail) return <DetailPane row={selectedRow(state)} env={env} />;
  switch (state.pane) {
    case 'inbox':
      return <InboxPane state={state} env={env} />;
    case 'history':
      return <HistoryPane state={state} env={env} />;
    case 'activity':
      return <ActivityPane state={state} env={env} />;
    case 'vault':
      return <VaultPane state={state} env={env} />;
    case 'recovery':
      return <RecoveryPane state={state} env={env} />;
    case 'propose':
      return <ProposePane state={state} />;
    default: {
      const never: never = state.pane;
      throw new Error(`unhandled pane: ${String(never)}`);
    }
  }
}

/** The key legend, scoped to what the current pane can actually do. */
function keyLegend(state: TuiState): string {
  const vaults = state.vaults.length > 1 ? ' · [/] vault' : '';
  if (state.detail) return 'a approve · x execute · q back';
  if (state.pane === 'propose') return 'tab field · ←/→ kind · enter build · esc leave';
  if (state.pane === 'recovery' && state.recovery) {
    return `c cancel · a approve · x execute · tab pane${vaults} · r refresh · q quit`;
  }
  return `tab pane · j/k move · enter open${vaults} · r refresh · q quit`;
}

function Footer({ state }: { state: TuiState }): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Text dimColor>{keyLegend(state)}</Text>
      {state.lastSignResult ? (
        <Text color={state.lastSignResult.ok ? 'green' : 'red'}>
          {state.lastSignResult.ok ? 'ok' : 'failed'}: {safeText(state.lastSignResult.message, 200)}
        </Text>
      ) : null}
    </Box>
  );
}
