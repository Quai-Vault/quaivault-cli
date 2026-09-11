import { Box, Text, useApp, useInput, usePaste, useStdout, useWindowSize, measureElement, type DOMElement } from 'ink';
import { useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { fit } from './text.js';
import { safeText } from '../format/index.js';
import type { TuiEnv } from './env.js';
import { mapKey, pastedText } from './keys.js';
import {
  PANES,
  FORM_FIELDS,
  HISTORY_KINDS,
  type HistoryKind,
  activeList,
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
  AssetsPane,
  DetailPane,
  HistoryPane,
  InboxPane,
  PolicyPane,
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
  onHistoryKind?: (dispatch: (event: TuiEvent) => void, address: string, kind: HistoryKind) => Promise<void>;
  onMoreHistory?: (dispatch: (event: TuiEvent) => void, address: string) => Promise<void>;
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
  assets: 'assets',
  vault: 'vault',
  recovery: 'recovery',
  policy: 'policy',
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
export const CHROME_ROWS = 8;

export function App({
  env,
  seed,
  onRefresh,
  onSelectVault,
  onMoreHistory,
  onHistoryKind,
  onSpawn,
  onSubscribe,
}: AppProps): React.ReactElement {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const size = useWindowSize();
  const [state, dispatch] = useReducer(reduce, seed ?? initialState());
  // While a child owns the terminal we must not act on input at all.
  const busy = useRef(false);
  const content = useRef<DOMElement>(null);

  const rows = size.rows || stdout?.rows || 24;
  const width = size.columns || stdout?.columns || 100;

  // Resize. The reducer has always had this event; nothing ever emitted it,
  // so the viewport was fixed at whatever the terminal was on launch.
  useEffect(() => {
    dispatch({ type: 'resize', rows: Math.max(1, rows - CHROME_ROWS) });
  }, [rows]);

  useEffect(() => {
    void onRefresh(dispatch);
    return onSubscribe?.(dispatch);
  }, [onRefresh, onSubscribe]);

  /**
   * The vault cursor moved, so the scoped panes are about to describe a
   * different vault. The reducer has already blanked them; this fetches.
   *
   * This also loads the first selected vault. Global refresh discovers the
   * vault list; this effect owns initial and subsequent selection changes.
   */
  const vaultAddress = selectedVault(state)?.address;
  const lastVault = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!vaultAddress) { lastVault.current = undefined; return; }
    if (lastVault.current === vaultAddress) return;
    lastVault.current = vaultAddress;
    void onSelectVault?.(dispatch, vaultAddress);
  }, [vaultAddress, onSelectVault]);

  useLayoutEffect(() => {
    if (content.current) dispatch({ type: 'body-size', rows: measureElement(content.current).height });
  });

  useEffect(() => {
    if (state.quit) exit();
  }, [state.quit, exit]);

  /**
   * Pasted text, on its own channel.
   *
   * `usePaste` turns on bracketed-paste mode, so the terminal frames the paste
   * and Ink keeps it off the `useInput` channel entirely. Nobody types a
   * 42-character address, so this is the primary way the propose form is
   * filled in.
   */
  usePaste((text) => {
    if (busy.current) return;
    dispatch({ type: 'paste', text });
  });

  useInput((input, key) => {
    if (busy.current) return;

    // Fallback for terminals without bracketed paste, where the text arrives
    // as ordinary input rather than through `usePaste`.
    const pasted = pastedText(input, key);
    if (pasted !== null) {
      dispatch({ type: 'paste', text: pasted });
      return;
    }

    const mapped = mapKey(input, key);
    if (mapped === null) return;
    // Overlays and text buffers own their keys; action shortcuts never leak through.
    if (width < 40 || rows < 12) {
      if (mapped === 'q') exit();
      return;
    }
    if (state.help || state.searching) {
      dispatch({ type: 'key', key: mapped });
      return;
    }

    const row = selectedRow(state);
    const vault = selectedVault(state);

    /**
     * Everything that changes the chain leaves the process here.
     *
     * Wrapped in `suspendTerminal`, which is the part that was missing: it
     * calls Ink's `pauseInput` — raw mode off, bracketed paste off, the stdin
     * listener detached and the handle unref'd — before the child starts.
     * Without it Ink kept reading the same file descriptor the child was
     * reading, and the two processes split the bytes between them, so roughly
     * every second character of a typed password went to the TUI and was
     * discarded. Erasing the frame with `clear()` did nothing about that.
     *
     * It also takes the terminal out of the alternate screen for the child's
     * §7 disclosure and puts it back afterwards, which is what the hand-rolled
     * escape sequences here used to do.
     */
    const spawn = (argv: string[], action: string, hash: string): void => {
      busy.current = true;
      dispatch({ type: 'sign-start', hash, action });
      void (async () => {
        let outcome = { ok: false, message: 'failed' };
        try {
          // Assigned inside the callback rather than dispatched from it: Ink
          // discards renders while suspended, so the result is applied once
          // the terminal is ours again and the redraw will actually show it.
          await suspendTerminal(async () => {
            outcome = await onSpawn(argv);
          });
        } catch {
          outcome = { ok: false, message: 'Could not complete the command. Refresh and review before retrying.' };
        } finally {
          dispatch({ type: 'sign-end', ok: outcome.ok, message: outcome.message });
          try { await onRefresh(dispatch); } finally { busy.current = false; }
        }
      })().catch(() => dispatch({ type: 'error', message: 'Refresh failed. Press r to retry.' }));
    };

    /**
     * Commit a policy edit.
     *
     * Spawns `qv policy set`, which is where validation and the write live —
     * the TUI produces argv and never touches the file. The one-shot refuses
     * without a terminal, so this path cannot be used to widen the bound from
     * a script; here there is a terminal by construction.
     */
    if (
      state.pane === 'policy' &&
      state.policyEdit !== null &&
      mapped === 'return' &&
      !state.detail
    ) {
      const line = state.policy?.[state.policyField];
      if (line) {
        const value = state.policyEdit;
        dispatch({ type: 'policy-edit', value: null });
        spawn(['policy', 'set', line.field, value], `policy ${line.field}`, '');
        return;
      }
    }

    if (state.pane === 'propose' && mapped === 'return' && state.form.field === FORM_FIELDS[state.form.kind].length - 1) {
      const argv = formArgv(state.form, vault?.address ?? '');
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
      if (mapped === 'u' && can('revokeApproval')) {
        spawn(['tx', 'unapprove', row.vault, row.tx.hash], 'unapprove', row.tx.hash);
        return;
      }
      if (mapped === 'c' && can('cancel')) {
        spawn(['tx', 'cancel', row.vault, row.tx.hash], 'cancel', row.tx.hash);
        return;
      }
      if (mapped === 'e' && can('expire')) {
        spawn(['tx', 'expire', row.vault, row.tx.hash], 'expire', row.tx.hash);
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
    if (state.pane === 'recovery' && vault && !state.detail && mapped === 's') {
      if (state.recoveryModule?.address && !state.recoveryModule.enabled) {
        spawn(
          ['propose', 'enable-recovery', vault.address],
          'enable social recovery',
          state.recoveryModule.address,
        );
        return;
      }
      if (state.recoveryModule?.address && state.recoveryModule.enabled) {
        dispatch({ type: 'open-form', kind: 'setup-recovery' });
        return;
      }
    }

    if (
      state.pane === 'recovery' &&
      vault &&
      !state.detail &&
      mapped === 'd' &&
      state.recoveryModule?.address &&
      state.recoveryModule.enabled
    ) {
      spawn(
        ['propose', 'disable-recovery', vault.address],
        'disable social recovery',
        state.recoveryModule.address,
      );
      return;
    }

    if (state.pane === 'recovery' && state.recovery && vault && !state.detail) {
      const hash = state.recovery.hash;
      const can = (action: string): boolean =>
        state.recovery?.affordances?.some((item) => item.action === action && item.allowed) === true;
      if (mapped === 'c' && can('cancel')) {
        spawn(['recovery', 'cancel', vault.address, hash], 'recovery cancel', hash);
        return;
      }
      if (mapped === 'a' && can('approve')) {
        spawn(['recovery', 'approve', vault.address, hash], 'recovery approve', hash);
        return;
      }
      if (mapped === 'x' && can('execute')) {
        spawn(['recovery', 'execute', vault.address, hash], 'recovery execute', hash);
        return;
      }
      if (mapped === 'u' && can('revokeApproval')) {
        spawn(['recovery', 'unapprove', vault.address, hash], 'recovery unapprove', hash);
        return;
      }
      if (mapped === 'e' && can('expire')) {
        spawn(['recovery', 'expire', vault.address, hash], 'recovery expire', hash);
        return;
      }
    }

    if (state.pane === 'history' && !state.detail && ['left', 'right'].includes(mapped) && vault) {
      const index = (HISTORY_KINDS.indexOf(state.historyKind) + (mapped === 'right' ? 1 : -1) + HISTORY_KINDS.length) % HISTORY_KINDS.length;
      dispatch({ type: 'key', key: mapped });
      void onHistoryKind?.(dispatch, vault.address, HISTORY_KINDS[index]!);
      return;
    }
    if (state.pane === 'history' && !state.detail && mapped === 'm' && (state.historyKind === 'transactions' ? state.historyHasMore : state.historyRecords[state.historyKind]?.hasMore) && vault) {
      void onMoreHistory?.(dispatch, vault.address);
      return;
    }
    if (mapped === 'r' && !(state.pane === 'propose' && state.form.field >= 0) && state.policyEdit === null) {
      void onRefresh(dispatch);
      return;
    }

    dispatch({ type: 'key', key: mapped });
  });

  const envWithWidth: TuiEnv = { ...env, width: Math.max(1, width - 4) };
  const scrollable = state.help || state.detail || (state.pane === 'history' && state.historyKind !== 'transactions') || ['vault', 'assets', 'recovery', 'activity'].includes(state.pane);
  if (width < 40 || rows < 12) return (
    <Box width={width} height={rows} flexDirection="column">
      <Text bold color="cyan">QuaiVault</Text>
      <Text>Enlarge this terminal to at least 40 columns × 12 rows.</Text>
      <Text dimColor>q quit · Ctrl-C exit</Text>
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={rows}>
      <Header state={state} env={{ ...env, width }} />
      <Tabs state={state} width={width} />
      <Status state={state} width={width} />
      <Box
        height={rows - 5}
        flexShrink={0}
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        paddingX={1}
        overflow="hidden"
      >
        <Box ref={content} flexDirection="column" flexShrink={0} marginTop={scrollable ? -state.bodyScroll : 0}>
          <Body state={state} env={envWithWidth} />
        </Box>
      </Box>
      <Footer state={state} width={width} />
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
    <Box height={1} flexShrink={0}>
      <Text wrap="truncate-end">
        <Text bold color="cyan">QuaiVault</Text>
        <Text dimColor> {safeText(env.profile ?? '', 24)} · </Text>
        {vault ? <Text bold>{safeText(vault.label, 24)}{many ? ` ${state.selectedVault + 1}/${state.vaults.length}` : ''}</Text> : <Text dimColor>No vault selected</Text>}
        {alarm ? <Text color="red" bold> · RECOVERY PENDING</Text> : null}
        {env.width >= 100 ? <Text dimColor> · {safeText(env.identity, 64)}</Text> : null}
      </Text>
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
function Tabs({ state, width }: { state: TuiState; width: number }): React.ReactElement {
  const index = PANES.indexOf(state.pane);
  const panes = width >= 100 ? PANES : PANES.slice(Math.max(0, index - 1), Math.max(0, index - 1) + (width >= 60 ? 4 : 2));
  return <Box height={1} flexShrink={0}>
    {panes.map((pane) => <Text key={pane} inverse={pane === state.pane} bold={pane === state.pane} dimColor={pane !== state.pane}>
      {` ${PANES.indexOf(pane) + 1} ${PANE_LABEL[pane]} `}
    </Text>)}
  </Box>;
}

function Status({ state, width }: { state: TuiState; width: number }): React.ReactElement {
  const error = state.scopedError ?? state.load.error;
  const text = state.pane === 'history' && !state.searching && !error ? `History: ${state.historyKind} · ←/→ category · m load more` : state.searching ? `Search: ${state.query}▏  Enter apply · Esc clear` : error ??
    (state.load.status === 'loading' || state.load.status === 'idle' ? 'Refreshing vaults…' :
      state.load.status === 'degraded' ? 'Indexer unavailable · lists may be incomplete · r retry' :
      `${state.rows.length} pending · ${state.vaults.length} vaults` + (state.load.fetchedAt ? ` · updated ${new Date(state.load.fetchedAt * 1000).toISOString().slice(11, 19)} UTC` : ''));
  return <Box height={1} flexShrink={0}><Text color={error || state.load.status === 'degraded' ? 'yellow' : undefined} dimColor={!error && !state.searching}>{fit(text, width)}</Text></Box>;
}

function Body({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  if (state.help) return <HelpPane />;
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
    case 'assets':
      return <AssetsPane state={state} env={env} />;
    case 'vault':
      return <VaultPane state={state} env={env} />;
    case 'recovery':
      return <RecoveryPane state={state} env={env} />;
    case 'policy':
      return <PolicyPane state={state} env={env} />;
    case 'propose':
      return <ProposePane state={state} env={env} />;
    default: {
      const never: never = state.pane;
      throw new Error(`unhandled pane: ${String(never)}`);
    }
  }
}

/** The key legend, scoped to what the current pane can actually do. */
function keyLegend(state: TuiState): string {
  if (state.help) return '↑/↓ scroll · ?/Esc close help';
  if (state.searching) return 'type to filter · Enter apply · Esc clear';
  const vaults = state.vaults.length > 1 ? ' · [/] vault' : '';
  if (state.detail) {
    const row = selectedRow(state);
    const allowed = new Set(
      row?.affordances.filter((item) => item.allowed).map((item) => item.action),
    );
    const actions = [
      allowed.has('approve') ? 'a approve' : '',
      allowed.has('revokeApproval') ? 'u unapprove' : '',
      allowed.has('execute') ? 'x execute' : '',
      allowed.has('cancel') ? 'c cancel' : '',
      allowed.has('expire') ? 'e expire' : '',
    ].filter(Boolean);
    return `${actions.join(' · ')}${actions.length ? ' · ' : ''}↑/↓ scroll · q back`;
  }
  if (state.pane === 'policy') {
    if (state.policyEdit !== null) return 'type to edit · enter apply · ctrl-u clear · esc cancel';
    return `j/k field · e edit · tab pane${vaults} · r refresh · q quit`;
  }
  if (state.pane === 'propose') return state.form.field < 0 ? '←/→ kind · Enter fill · Tab pane · ? help · q quit' : 'Tab field · ←/→ cursor · Enter next/build · Esc leave';
  if (state.pane === 'recovery') {
    const allowed = new Set(
      (state.recovery?.affordances ?? []).filter((item) => item.allowed).map((item) => item.action),
    );
    const actions = [
      state.recoveryModule?.address && !state.recoveryModule.enabled ? 's enable' : '',
      state.recoveryModule?.address && state.recoveryModule.enabled ? 's configure' : '',
      state.recoveryModule?.address && state.recoveryModule.enabled ? 'd disable' : '',
      allowed.has('cancel') ? 'c cancel' : '',
      allowed.has('approve') ? 'a approve' : '',
      allowed.has('revokeApproval') ? 'u unapprove' : '',
      allowed.has('execute') ? 'x execute' : '',
      allowed.has('expire') ? 'e expire' : '',
    ].filter(Boolean).join(' · ');
    return `${actions}${actions ? ' · ' : ''}tab pane${vaults} · r refresh · q quit`;
  }
  return `Tab pane · ↑/↓ move · Enter open${vaults} · / find · ? help · q quit`;
}

function Footer({ state, width }: { state: TuiState; width: number }): React.ReactElement {
  const list = activeList(state);
  const scrollable = state.help || state.detail || (state.pane === 'history' && state.historyKind !== 'transactions') || ['vault', 'assets', 'recovery', 'activity'].includes(state.pane);
  const position = scrollable && state.bodyRows > state.viewport ? `Lines ${state.bodyScroll + 1}–${Math.min(state.bodyScroll + state.viewport, state.bodyRows)}/${state.bodyRows} · PgUp/PgDn scroll` :
    list.length ? `${state.selected + 1}/${list.length}${state.query ? ` · filter: ${state.query}` : ''}${state.pane === 'history' && state.historyHasMore ? ' · m load more history' : ''}` :
      '1–8 jump to pane · r refresh · ? all shortcuts';
  const compact = state.help ? '?/Esc close · ↑/↓ scroll' : state.searching ? 'Enter apply · Esc clear · Ctrl-U erase' :
    state.pane === 'propose' && state.form.field >= 0 ? 'Esc leave · Tab field · Enter next/build' :
    state.policyEdit !== null ? 'Esc cancel · Enter apply · Ctrl-U clear' :
    state.detail ? 'q back · ? help · ↑/↓ scroll' : 'q quit · ? help · Tab pane · ↑/↓ move';
  return <Box height={2} flexShrink={0} flexDirection="column">
    <Text dimColor>{fit(width < 80 ? compact : keyLegend(state), width)}</Text>
    <Text color={state.lastSignResult?.ok === false ? 'red' : undefined} dimColor={!state.lastSignResult}>
      {fit(state.lastSignResult ? `${state.lastSignResult.ok ? 'ok' : 'failed'}: ${safeText(state.lastSignResult.message, 200)} · ${position}` : position, width)}
    </Text>
  </Box>;
}

function HelpPane(): React.ReactElement {
  return <Box flexDirection="column">
    <Text bold color="cyan">Keyboard guide</Text>
    <Text>Tab / Shift-Tab   Next / previous pane</Text>
    <Text>1–8              Jump to a pane</Text>
    <Text>[ / ]            Previous / next vault</Text>
    <Text>↑/↓ or j/k       Move through lists; scroll details</Text>
    <Text>PgUp / PgDn      Move one page</Text>
    <Text>Home / End, g/G  First / last row or line</Text>
    <Text>/                Search inbox/history; Enter applies</Text>
    <Text>Esc              Clear search or close details</Text>
    <Text>Enter            Open selected transaction</Text>
    <Text>←/→ in history   Transactions / deposits / transfers / recoveries</Text>
    <Text>m                Load more history</Text>
    <Text>r                Refresh data</Text>
    <Text>?                Show / close this guide</Text>
    <Text>q / Ctrl-C       Back / quit</Text>
    <Text> </Text>
    <Text bold>Proposals and policy fields</Text>
    <Text>←/→              Move cursor (choose kind on selector)</Text>
    <Text>Home/End         Start / end of field</Text>
    <Text>Ctrl-U           Clear field</Text>
    <Text>Ctrl-W / Ctrl-K  Delete word / delete to end</Text>
    <Text>Tab/Shift-Tab    Next / previous field</Text>
    <Text>Enter            Next field; build on last field</Text>
    <Text>Esc              Leave form / cancel policy edit</Text>
    <Text> </Text>
    <Text bold>Recovery</Text>
    <Text>←/→              Previous / next recovery request</Text>
    <Text>s / d            Configure or enable / disable</Text>
    <Text>a / u / x        Approve / unapprove / execute</Text>
    <Text>c / e            Cancel / expire when permitted</Text>
    <Text> </Text>
    <Text>Each write opens a separate command for review and confirmation.</Text>
    <Text>Paste uses your terminal’s normal shortcut. Mouse selection stays available.</Text>
  </Box>;
}
