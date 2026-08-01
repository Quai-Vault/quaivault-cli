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

export function App({ env, seed, onRefresh, onSpawn, onSubscribe }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  const [state, dispatch] = useReducer(reduce, seed ?? initialState());
  // While a child owns the terminal we must not act on input at all.
  const busy = useRef(false);

  // Resize. The reducer has always had this event; nothing ever emitted it,
  // so the viewport was fixed at whatever the terminal was on launch.
  useEffect(() => {
    dispatch({ type: 'resize', rows: Math.max(3, (size.rows || 24) - 10) });
  }, [size.rows]);

  useEffect(() => {
    void onRefresh(dispatch);
    return onSubscribe?.(dispatch);
  }, [onRefresh, onSubscribe]);

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

    if (state.pane === 'recovery' && mapped === 'c' && state.recovery && vault) {
      spawn(
        ['recovery', 'cancel', vault.address, state.recovery.hash],
        'recovery cancel',
        state.recovery.hash,
      );
      return;
    }

    if (mapped === 'r' && state.pane !== 'propose') {
      void onRefresh(dispatch);
      return;
    }

    dispatch({ type: 'key', key: mapped });
  });

  const width = stdout?.columns ?? 100;
  const envWithWidth: TuiEnv = { ...env, width };

  return (
    <Box flexDirection="column" width={width}>
      <Header state={state} env={envWithWidth} />
      <Tabs state={state} />
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <Body state={state} env={envWithWidth} />
      </Box>
      <Footer state={state} />
    </Box>
  );
}

function Header({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const vault = selectedVault(state);
  const alarm = state.vaults.some((v) => v.hasRecovery);
  return (
    <Box>
      <Text bold>QuaiVault</Text>
      <Text dimColor> · {env.identity}</Text>
      {vault ? <Text> · {safeText(vault.label, 24)}</Text> : null}
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

function Tabs({ state }: { state: TuiState }): React.ReactElement {
  return (
    <Box>
      {PANES.map((p) => (
        <Text key={p} color={p === state.pane ? 'cyan' : undefined} dimColor={p !== state.pane}>
          {p === state.pane ? `[${PANE_LABEL[p]}] ` : ` ${PANE_LABEL[p]}  `}
        </Text>
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
      return <ActivityPane state={state} />;
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

function Footer({ state }: { state: TuiState }): React.ReactElement {
  const keys = state.detail
    ? 'a approve · x execute · q back'
    : state.pane === 'propose'
      ? 'tab field · ←/→ kind · enter build · esc leave'
      : state.pane === 'recovery' && state.recovery
        ? 'c cancel recovery · tab pane · r refresh · q quit'
        : 'tab pane · j/k move · enter open · r refresh · q quit';
  return (
    <Box flexDirection="column">
      <Text dimColor>{keys}</Text>
      {state.lastSignResult ? (
        <Text color={state.lastSignResult.ok ? 'green' : 'red'}>
          {state.lastSignResult.ok ? 'ok' : 'failed'}: {safeText(state.lastSignResult.message, 200)}
        </Text>
      ) : null}
    </Box>
  );
}
