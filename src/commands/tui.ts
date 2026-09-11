import { mapPooled, type Subscription, type VaultTransaction, type WatchEvent } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { ExitCode } from '../cli/exit.js';
import { UsageError, type AppContext } from '../context/context.js';
import { POLICY_FIELDS, loadPolicy, policyValue } from '../context/policy.js';
import { batchOf } from '../render/transaction.js';
import { ChangeFeed } from '../store/index.js';
import { planChannels, type ChannelPlan } from '../store/channels.js';
import type { TuiEnv } from '../tui/env.js';
import type {
  HistoryKind,
  HistoryRecord,
  PolicyLine,
  RecoveryDetail,
  RecoveryModuleDetail,
  TuiEvent,
  TuiRow,
  VaultSummary,
} from '../tui/reducer.js';
import { latestRequest } from '../tui/requests.js';
import { holdUntilAcknowledged, signerArgv, spawnSigner } from '../tui/spawn-signer.js';

/**
 * `qv tui` — a full-screen monitoring and review surface.
 *
 * It holds **no key** and can do nothing the one-shot surface cannot: every
 * write is a spawned `qv …` invocation whose §7 disclosure and confirmation
 * prompt the user sees directly. That makes the rule structural rather than a
 * convention.
 *
 * Bare `qv` never launches this — an agent must not land in a full-screen app
 * it cannot exit.
 *
 * **Ink and React are reached through a dynamic import**, and tsup runs with
 * `splitting: true` so they land in a separate chunk. A static import would
 * put React on the critical path of every `qv inbox` — ~420 ms an agent
 * invoking us hundreds of times would pay for a UI it never draws.
 * `test/unit/bundle.test.ts` asserts it stays that way.
 */

type Dispatch = (event: TuiEvent) => void;

/** The policy as display lines, or null when there is no policy file. */
function policyLines(): PolicyLine[] | null {
  const policy = loadPolicy();
  if (!policy) return null;
  return POLICY_FIELDS.map((field) => ({ field, value: policyValue(policy, field) }));
}

function labelFor(ctx: AppContext, address: string): string {
  const found = Object.entries(ctx.config.aliases).find(
    ([, v]) => v.toLowerCase() === address.toLowerCase(),
  );
  return found ? found[0] : `${address.slice(0, 8)}…`;
}

/** Vaults the identity touches. */
async function loadVaults(ctx: AppContext, identity: string): Promise<{ vaults: string[]; truncated: boolean }> {
  const [owned, guardian] = await Promise.all([
    addressPages((offset) => ctx.qv.vaults.forOwner(identity, { limit: 100, offset })),
    addressPages((offset) => ctx.qv.vaults.forGuardian(identity, { limit: 100, offset })),
  ]);
  const addresses = new Map([...owned.rows, ...guardian.rows].map((a) => [a.toLowerCase(), a]));
  return { vaults: [...addresses.values()], truncated: owned.truncated || guardian.truncated };
}

export async function addressPages(read: (offset: number) => Promise<string[]>): Promise<{ rows: string[]; truncated: boolean }> {
  const found = new Map<string, string>();
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await read(offset);
    for (const address of page) found.set(address.toLowerCase(), address);
    if (page.length < 100) return { rows: [...found.values()], truncated: false };
  }
  return { rows: [...found.values()], truncated: true };
}

async function rowsFor(
  ctx: AppContext,
  address: string,
  identity: string,
  txs: VaultTransaction[],
  chainHead?: number,
): Promise<TuiRow[]> {
  const vault = ctx.qv.vault(address);
  const affs = await mapPooled(txs, 4, (tx) => vault.affordances(tx.hash, identity));
  return txs.map((tx, i) => ({
    vault: address,
    vaultLabel: labelFor(ctx, address),
    tx,
    affordances: affs[i] ?? [],
    // Computed here rather than in `tui/`, which may not import SDK values.
    batch: batchOf(tx, ctx),
    ...(chainHead !== undefined ? { chainHead } : {}),
  }));
}

/**
 * Urgency order, and a total one.
 *
 * Closest to actionable first — fewest approvals still needed — then the
 * transaction hash to break ties. The hash tiebreak is what makes the order
 * *stable*: without it, two equally-urgent transactions can swap places
 * between refreshes and the selection follows the index, not the transaction.
 */
function sortInbox(rows: TuiRow[]): TuiRow[] {
  return [...rows].sort((a, b) => {
    const needA = Math.max(0, a.tx.threshold - a.tx.approvalCount);
    const needB = Math.max(0, b.tx.threshold - b.tx.approvalCount);
    if (needA !== needB) return needA - needB;
    return a.tx.hash < b.tx.hash ? -1 : a.tx.hash > b.tx.hash ? 1 : 0;
  });
}

interface PendingRecoveryRow {
  hash: string;
  newOwners: string[];
  newThreshold: number;
  approvalCount: number;
  requiredThreshold: number;
  executionTime?: number;
  expiration?: number;
}

/**
 * Load the panes that describe **one** vault: detail, recovery and history.
 *
 * Split out of `refresh` so switching the vault cursor does not re-read every
 * vault's pending set just to repaint the scoped panes. Both callers dispatch
 * the same events, so a switch and a refresh leave the UI in the same shape.
 */
export async function loadVaultScoped(
  ctx: AppContext,
  dispatch: Dispatch,
  address: string,
  identity: string,
  historyLimit = 50,
  historyKind: HistoryKind = 'transactions',
): Promise<void> {
  const vault = ctx.qv.vault(address);
  const moduleAddress = ctx.qv.config.contracts.socialRecovery ?? null;
  const recoveryReads = moduleAddress
    ? Promise.all([
        vault.recovery.isEnabled(),
        vault.recovery.config(),
        vault.recovery.pending(),
      ] as const).then(([enabled, config, pending]) => ({ enabled, config, pending }))
    : Promise.resolve({ enabled: false, config: null, pending: [] as PendingRecoveryRow[] });

  // Independent panes can succeed even when another read fails.
  const results = await Promise.allSettled([
    (async () => {
      const [info, modules, balances, delegatecallTargets, signedMessages] = await Promise.all([
        vault.info(), vault.modules(), vault.balances({ verify: false }), vault.delegatecallTargets(), vault.signedMessages(),
      ]);
      dispatch({ type: 'vault-detail', address, detail: {
        owners: info.owners, threshold: info.threshold, minExecutionDelay: info.minExecutionDelay,
        modules, balanceWei: balances.native, tokens: balances.tokens, delegatecallTargets, signedMessages: signedMessages.map((r) => r.msg_hash),
      } });
    })(),
    (async () => {
      const recoveryState = await recoveryReads;
      const recoveryModule: RecoveryModuleDetail = {
        address: moduleAddress, enabled: recoveryState.enabled,
        configured: recoveryState.config?.configured ?? false,
        guardians: recoveryState.config?.guardians ?? [],
        threshold: recoveryState.config?.threshold ?? 0,
        recoveryPeriod: recoveryState.config?.recoveryPeriod ?? 0,
      };
      const details = await mapPooled(recoveryState.pending as PendingRecoveryRow[], 4, async (r): Promise<RecoveryDetail> => ({
        hash: r.hash, newOwners: r.newOwners, newThreshold: r.newThreshold,
        approvals: r.approvalCount, required: r.requiredThreshold,
        ...(r.executionTime ? { executableAt: r.executionTime } : {}),
        ...(r.expiration ? { expiration: r.expiration } : {}),
        affordances: await vault.recovery.affordances(r.hash, identity),
      }));
      dispatch({ type: 'recovery-module', address, detail: recoveryModule });
      dispatch({ type: 'recoveries', address, details });
    })(),
    (async () => {
      if (historyKind !== 'transactions') {
        const read = async (limit: number, offset: number): Promise<{ data: HistoryRecord[]; hasMore: boolean }> => {
          if (historyKind === 'deposits') {
            const page = await vault.deposits({ limit, offset });
            return { hasMore: page.hasMore, data: page.data.map((r) => ({ title: `Deposit · block ${r.deposited_at_block}`, lines: [`From: ${r.sender_address}`, `Amount: ${r.amount} wei`, `Transaction: ${r.deposited_at_tx}`] })) };
          }
          if (historyKind === 'transfers') {
            const page = await vault.tokenTransfers({ limit, offset });
            return { hasMore: page.hasMore, data: page.data.map((r) => ({ title: `${r.direction} · block ${r.block_number}`, lines: [`Token: ${r.token_address}`, `From: ${r.from_address}`, `To: ${r.to_address}`, `Amount: ${r.value} base units${r.token_id ? ` · token ID: ${r.token_id}` : ''}`, `Transaction: ${r.transaction_hash}`] })) };
          }
          const page = await vault.recovery.history({ limit, offset });
          return { hasMore: page.length === limit, data: page.map((r) => ({ title: `Recovery · ${r.status}`, lines: [`Request: ${r.hash}`, `Threshold: ${r.newThreshold}`, ...r.newOwners.map((owner) => `Owner: ${owner}`)] })) };
        };
        const records: HistoryRecord[] = [];
        let hasMore = false;
        while (records.length < historyLimit) {
          const page = await read(Math.min(100, historyLimit - records.length), records.length);
          records.push(...page.data);
          hasMore = page.hasMore;
          if (!hasMore || !page.data.length) break;
        }
        dispatch({ type: 'history-records', address, kind: historyKind, page: { records, hasMore } });
        return;
      }
      const [page, health] = await Promise.all([
        historyPages((limit, offset) => vault.transactionHistory({ limit, offset }), historyLimit), ctx.qv.indexerHealth().catch(() => null),
      ]);
      dispatch({ type: 'history', address, hasMore: page.hasMore,
        rows: await rowsFor(ctx, address, identity, page.data, health?.chainHead) });
    })(),
  ]);
  const names = ['Vault/assets', 'Recovery', 'History'];
  const failures = results.flatMap((r, i) => r.status === 'rejected' ? [names[i]!] : []);
  dispatch({ type: 'scoped-error', address, message: failures.length
    ? `${failures.join(', ')} refresh failed; displayed data may be stale. Press r to retry.` : undefined });

}

/**
 * One refresh. The cross-vault inbox lands first so the default pane paints,
 * then the slower per-vault reads for the other panes.
 *
 * Scoped reads are coordinated separately. Discovery cannot overwrite a
 * selection the user changed while the global request was in flight.
 */
async function refresh(
  ctx: AppContext,
  dispatch: Dispatch,
  vaultsOut: (vaults: string[]) => void,
): Promise<void> {
  const identity = ctx.identity();
  if (!identity) throw new UsageError('No identity set.', 'qv use --as 0x…');
  dispatch({ type: 'loading' });

  const [discovery, health] = await Promise.all([
    loadVaults(ctx, identity),
    ctx.qv.indexerHealth().catch(() => null),
  ]);
  const { vaults } = discovery;
  vaultsOut(vaults);
  const degraded = health?.available !== true;

  // A local file read, so it rides along with every refresh — including the
  // one that runs after `qv policy set` returns, which is what makes an edit
  // appear applied.
  dispatch({ type: 'policy', lines: policyLines() });

  // Indexed rather than pushed. Pushing from inside `Promise.all` orders the
  // list by whichever vault's reads happen to resolve first, so the inbox
  // reshuffles between refreshes — and on a surface that auto-refreshes on
  // chain events, the row under the cursor can change identity between
  // looking at it and pressing `a`. Observed against 25 live Orchard vaults.
  const warnings: string[] = discovery.truncated ? ['Vault discovery capped at 1,000 per role; additional vaults may be missing'] : [];
  const perVault = await mapPooled(vaults, 4, async (address, i) => {
    const vault = ctx.qv.vault(address);
    try {
      const [pending, hasRecovery] = await Promise.all([
        pendingPages((offset) => vault.pendingTransactions({ limit: 100, offset })),
        vault.recovery.hasPending(),
      ]);
      if (pending.truncated) warnings.push(`${labelFor(ctx, address)}: showing first 1,000 pending transactions`);
      return { i, summary: { address, label: labelFor(ctx, address), pending: pending.rows.length, hasRecovery } satisfies VaultSummary,
        rows: await rowsFor(ctx, address, identity, pending.rows, health?.chainHead) };
    } catch {
      warnings.push(`${labelFor(ctx, address)}: unable to load transactions or recovery status`);
      return { i, summary: { address, label: labelFor(ctx, address), pending: 0, hasRecovery: false } satisfies VaultSummary, rows: [] as TuiRow[] };
    }
  });
  perVault.sort((a, b) => a.i - b.i);
  dispatch({ type: 'vaults', vaults: perVault.map((v) => v.summary) });
  dispatch({ type: 'data', rows: sortInbox(perVault.flatMap((v) => v.rows)),
    degraded: degraded || warnings.length > 0, at: ctx.now(),
    warning: warnings.length ? warnings.join('; ') : undefined });

}

/** Walk pending pages with an explicit resource bound, never a silent first page. */
export async function pendingPages(read: (offset: number) => Promise<VaultTransaction[]>): Promise<{ rows: VaultTransaction[]; truncated: boolean }> {
  const rows = new Map<string, VaultTransaction>();
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await read(offset);
    for (const tx of page) rows.set(tx.hash, tx);
    if (page.length < 100) return { rows: [...rows.values()], truncated: false };
  }
  return { rows: [...rows.values()], truncated: true };
}

export async function historyPages(
  read: (limit: number, offset: number) => Promise<{ data: VaultTransaction[]; hasMore: boolean }>,
  target: number,
): Promise<{ data: VaultTransaction[]; hasMore: boolean }> {
  const rows = new Map<string, VaultTransaction>();
  let offset = 0;
  let hasMore = false;
  while (offset < target) {
    const page = await read(Math.min(100, target - offset), offset);
    for (const tx of page.data) rows.set(tx.hash, tx);
    offset += page.data.length;
    hasMore = page.hasMore;
    if (!page.hasMore || !page.data.length) break;
  }
  return { data: [...rows.values()], hasMore };
}

/** Subscribe within the channel budget; events become staleness and activity. */
function subscribe(
  ctx: AppContext,
  vaults: readonly string[],
  dispatch: Dispatch,
  onChange: () => void,
): { plan: ChannelPlan; close: () => Promise<void> } {
  const plan = planChannels(vaults);
  const feed = new ChangeFeed(ctx.store);
  const subs: Subscription[] = [];
  for (const address of plan.subscribed) {
    try {
      subs.push(
        ctx.qv.vault(address).watch(
          (event: WatchEvent) => {
            feed.push(address, event);
            // Activity and refresh are event-driven, not conditional on a
            // matching cache entry existing.
            dispatch({
              type: 'activity',
              entry: {
                at: ctx.now(),
                topic: event.topic,
                type: event.type,
                vault: labelFor(ctx, address),
              },
            });
            onChange();
          },
          { topics: ['transactions', 'confirmations', 'owners', 'modules', 'recoveries', 'deposits', 'tokenTransfers', 'signedMessages'] },
        ),
      );
    } catch {
      // A channel that will not open is a degraded refresh, not a dead UI.
    }
  }
  return {
    plan,
    close: async () => {
      // Awaited rather than fired and forgotten. `unsubscribe` returns a
      // promise that closes a Realtime channel; dropping it left channels
      // half-torn-down at exit.
      await Promise.allSettled(subs.map((sub) => sub.unsubscribe()));
    },
  };
}

export const tuiCommand: CommandSpec<Record<string, never>, { exited: true }> = {
  path: ['tui'],
  describe: 'Full-screen monitor for your vaults (signs by delegation)',
  needs: { identity: true, indexer: 'required' },

  async run(ctx) {
    // Refuse unless BOTH streams are a terminal: a TUI on a pipe emits escape
    // codes into a file, and one with no stdin cannot read a key.
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      throw new UsageError(
        'qv tui needs an interactive terminal on both stdin and stdout.',
        'For scripting use the one-shot commands with --json.',
      );
    }
    if (ctx.flags.json) {
      throw new UsageError('qv tui has no --json form.', 'Use `qv inbox --json`.');
    }
    if (ctx.flags.noInput) {
      throw new UsageError('qv tui requires interactive input.', 'Use one-shot commands with --no-input.');
    }
    // Ink initializes its color support during import, independently of our
    // one-shot renderer. Apply the explicit preference before loading it.
    if (ctx.flags.color !== 'auto') {
      process.env.FORCE_COLOR = ctx.flags.color === 'never' ? '0' : '1';
    }

    // Ink and React load here and nowhere else. See the note at the top.
    const [ink, appModule, react] = await Promise.all([
      import('ink'),
      import('../tui/app.js'),
      import('react'),
    ]);

    const env: TuiEnv = {
      identity: ctx.identity() ?? '',
      profile: ctx.profileName,
      contactName: (address) => ctx.contactName(address),
      now: () => ctx.now(),
      width: process.stdout.columns ?? 100,
    };

    let watching: { plan: ChannelPlan; close: () => Promise<void> } | undefined;
    let vaults: string[] = [];
    let redraw: (() => void) | undefined;
    /** The vault the cursor is on. Survives refreshes; drives the scoped panes. */
    let currentVault: string | undefined;
    let watchedKey = '';
    let refreshing = false;
    let refreshAgain = false;
    let closed = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let historyLimit = 50;
    let historyKind: HistoryKind = 'transactions';
    let scoped: ReturnType<typeof latestRequest<TuiEvent>> | undefined;
    const onSelectVault = async (dispatch: Dispatch, address: string, more = false): Promise<void> => {
      if (closed) return;
      if (currentVault !== address) historyLimit = 50;
      if (more) historyLimit += 50;
      currentVault = address;
      scoped ??= latestRequest(dispatch);
      await scoped.run((emit) => loadVaultScoped(ctx, emit, address, ctx.identity() ?? '', historyLimit, historyKind),
        () => ({ type: 'scoped-error', address, message: 'Vault refresh failed. Press r to retry.' }));
    };

    const doRefresh = async (dispatch: Dispatch): Promise<void> => {
      if (closed) return;
      if (refreshing) {
        refreshAgain = true;
        return;
      }
      refreshing = true;
      try {
        do {
          refreshAgain = false;
          await refresh(ctx, dispatch, (found) => { vaults = found; });
          if (closed) break;
          // The selection callback owns currentVault; an old global refresh never overwrites it.
          if (currentVault && vaults.some((v) => v.toLowerCase() === currentVault!.toLowerCase())) {
            await onSelectVault(dispatch, currentVault);
          }
          const nextKey = vaults.map((vault) => vault.toLowerCase()).join(',');
          if (nextKey !== watchedKey) {
            await watching?.close();
            if (closed) break;
            watching = subscribe(ctx, vaults, dispatch, () => {
              if (refreshTimer || closed) return;
              refreshTimer = setTimeout(() => { refreshTimer = undefined; redraw?.(); }, 500);
            });
            watchedKey = nextKey;
          }
        } while (refreshAgain && !closed);
      } catch (err) {
        dispatch({ type: 'error', message: err instanceof Error ? err.message : 'load failed' });
      } finally {
        refreshing = false;
      }
    };

    /**
     * Hand the terminal over (§4.4, "drops raw mode, leaves the screen,
     * spawns").
     *
     * The dropping and the leaving are `suspendTerminal`'s job now — the App
     * wraps this call in it. Ink turns raw mode off, unrefs stdin, detaches
     * its listener, exits the alternate screen for the child's §7 disclosure,
     * and reverses all of it afterwards.
     */
    const onSpawn = async (argv: string[]): Promise<{ ok: boolean; message: string }> => {
      const outcome = await spawnSigner(signerArgv(argv, {
        profile: ctx.profileName, identity: ctx.identity() ?? '',
        color: ctx.flags.color, dryRun: ctx.flags.dryRun,
      }));
      // 130 is Ctrl-C: the user is already leaving and does not need a prompt
      // explaining why. Everything else gets read before the screen flips back.
      if (outcome.exitCode !== 130) {
        await holdUntilAcknowledged(
          `\n  ${outcome.message} — review the result above.\n  Press any key to return. `,
        );
      }
      return { ok: outcome.ok, message: outcome.message };
    };

    const app = ink.render(
      react.createElement(appModule.App, {
        env,
        onRefresh: (dispatch: Dispatch) => {
          redraw = () => void doRefresh(dispatch);
          return doRefresh(dispatch);
        },
        onSelectVault,
        onHistoryKind: (dispatch: Dispatch, address: string, kind: HistoryKind) => {
          historyKind = kind;
          historyLimit = 50;
          return onSelectVault(dispatch, address);
        },
        onMoreHistory: (dispatch: Dispatch, address: string) => onSelectVault(dispatch, address, true),
        onSpawn,
      }),
      // btop/htop-style, and Ink's own option rather than hand-written escape
      // sequences: it knows to leave the alternate screen around a suspension
      // and to restore the primary screen on unmount, including on a signal.
      { exitOnCtrlC: true, alternateScreen: true, kittyKeyboard: { mode: 'auto' }, maxFps: 30 },
    );
    // Heal missed socket events and tail vaults beyond the realtime-channel budget.
    const pollTimer = setInterval(() => redraw?.(), 15_000);

    try {
      await app.waitUntilExit();
    } finally {
      closed = true;
      scoped?.close();
      clearTimeout(refreshTimer);
      clearInterval(pollTimer);
      // Awaited, not fired and forgotten: each one closes a Realtime channel.
      await watching?.close();
    }

    /**
     * Leave deliberately, because nothing else can.
     *
     * `@supabase/realtime-js` opens a WebSocket and starts a heartbeat
     * `setInterval`, and unrefs neither; the SDK keeps that client private and
     * exposes no disconnect, only per-channel removal. So once `watch()` has
     * been called the event loop can never drain, and `main()` sets
     * `process.exitCode` and returns rather than exiting. The visible symptom
     * was pressing `q`, watching the app disappear, and getting no shell
     * prompt back without Ctrl-C.
     *
     * `qv watch` never showed this because SIGINT is its only exit path, and
     * the SIGINT handler in `bin/qv.ts` calls `process.exit` outright.
     *
     * Safe here: the TUI renders nothing on the way out (`render` returns
     * undefined, and there is no `--json` form), and writes to a TTY are
     * synchronous, so Ink's screen restore has already landed.
     */
    process.exit(ExitCode.Ok);
  },

  render: () => undefined,
  toJson: () => ({ exited: true }),
  outputSchema: { type: 'object', properties: { exited: { type: 'boolean' } } },
};
