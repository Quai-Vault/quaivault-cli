import type { Affordance, Subscription, VaultTransaction, WatchEvent } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { ExitCode } from '../cli/exit.js';
import { UsageError, type AppContext } from '../context/context.js';
import { batchOf } from '../render/transaction.js';
import { ChangeFeed } from '../store/index.js';
import { planChannels, type ChannelPlan } from '../store/channels.js';
import type { TuiEnv } from '../tui/env.js';
import type { RecoveryDetail, TuiEvent, TuiRow, VaultSummary } from '../tui/reducer.js';
import { spawnSigner } from '../tui/spawn-signer.js';

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

function labelFor(ctx: AppContext, address: string): string {
  const found = Object.entries(ctx.config.aliases).find(
    ([, v]) => v.toLowerCase() === address.toLowerCase(),
  );
  return found ? found[0] : `${address.slice(0, 8)}…`;
}

/** Vaults the identity touches. */
async function loadVaults(ctx: AppContext, identity: string): Promise<string[]> {
  const [owned, guardian] = await Promise.all([
    ctx.qv.vaults.forOwner(identity).catch(() => [] as string[]),
    ctx.qv.vaults.forGuardian(identity).catch(() => [] as string[]),
  ]);
  return [...new Set([...owned, ...guardian])].slice(0, 25);
}

async function rowsFor(
  ctx: AppContext,
  address: string,
  identity: string,
  txs: VaultTransaction[],
): Promise<TuiRow[]> {
  const vault = ctx.qv.vault(address);
  const affs = await Promise.all(
    txs.map((tx) => vault.affordances(tx.hash, identity).catch(() => [] as Affordance[])),
  );
  return txs.map((tx, i) => ({
    vault: address,
    vaultLabel: labelFor(ctx, address),
    tx,
    affordances: affs[i] ?? [],
    // Computed here rather than in `tui/`, which may not import SDK values.
    batch: batchOf(tx, ctx),
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
 * vault's pending set just to repaint three panes. Both callers dispatch the
 * same three events, so a switch and a refresh leave the UI in the same shape.
 */
async function loadVaultScoped(
  ctx: AppContext,
  dispatch: Dispatch,
  address: string,
  identity: string,
): Promise<void> {
  const vault = ctx.qv.vault(address);
  const [info, balances, history, pendingRecovery] = await Promise.all([
    vault.info().catch(() => null),
    vault.balances({ verify: false }).catch(() => null),
    vault
      .transactionHistory({ limit: 50 })
      .then((p) => p.data)
      .catch((): VaultTransaction[] => []),
    vault.recovery.pending().catch(() => [] as PendingRecoveryRow[]),
  ]);

  dispatch({
    type: 'vault-detail',
    detail: info
      ? {
          owners: info.owners,
          threshold: info.threshold,
          minExecutionDelay: info.minExecutionDelay,
          modules: [],
          balanceWei: balances?.native ?? info.balance,
        }
      : null,
  });

  const first = (pendingRecovery as PendingRecoveryRow[])[0];
  const recovery: RecoveryDetail | null = first
    ? {
        hash: first.hash,
        newOwners: first.newOwners,
        newThreshold: first.newThreshold,
        approvals: first.approvalCount,
        required: first.requiredThreshold,
        ...(first.executionTime ? { executableAt: first.executionTime } : {}),
        ...(first.expiration ? { expiration: first.expiration } : {}),
      }
    : null;
  dispatch({ type: 'recovery', detail: recovery });

  dispatch({ type: 'history', rows: await rowsFor(ctx, address, identity, history) });
}

/**
 * One refresh. The cross-vault inbox lands first so the default pane paints,
 * then the slower per-vault reads for the other panes.
 *
 * `preferred` is the vault the cursor is currently on. It is honoured when it
 * still exists, so a refresh — which fires on every chain event — never yanks
 * the vault-scoped panes back to whichever vault the indexer happened to
 * return first. Returns the address actually shown, for the caller to keep.
 */
async function refresh(
  ctx: AppContext,
  dispatch: Dispatch,
  vaultsOut: (vaults: string[]) => void,
  preferred?: string,
): Promise<string | undefined> {
  const identity = ctx.identity();
  if (!identity) throw new UsageError('No identity set.', 'qv use --as 0x…');
  dispatch({ type: 'loading' });

  const [vaults, health] = await Promise.all([
    loadVaults(ctx, identity),
    ctx.qv.indexerHealth().catch(() => null),
  ]);
  vaultsOut(vaults);
  const degraded = health?.available === false;

  // Indexed rather than pushed. Pushing from inside `Promise.all` orders the
  // list by whichever vault's reads happen to resolve first, so the inbox
  // reshuffles between refreshes — and on a surface that auto-refreshes on
  // chain events, the row under the cursor can change identity between
  // looking at it and pressing `a`. Observed against 25 live Orchard vaults.
  const perVault = await Promise.all(
    vaults.map(async (address, i) => {
      const vault = ctx.qv.vault(address);
      const [pending, hasRecovery] = await Promise.all([
        vault.pendingTransactions({ limit: 50 }).catch((): VaultTransaction[] => []),
        vault.recovery.hasPending().catch(() => false),
      ]);
      return {
        i,
        summary: {
          address,
          label: labelFor(ctx, address),
          pending: pending.length,
          hasRecovery,
        } satisfies VaultSummary,
        rows: await rowsFor(ctx, address, identity, pending),
      };
    }),
  );
  perVault.sort((a, b) => a.i - b.i);

  dispatch({ type: 'vaults', vaults: perVault.map((v) => v.summary) });
  dispatch({ type: 'data', rows: sortInbox(perVault.flatMap((v) => v.rows)), degraded, at: ctx.now() });

  // Honour the cursor, not the indexer's ordering.
  const address = vaults.find((v) => v.toLowerCase() === preferred?.toLowerCase()) ?? vaults[0];
  if (!address) {
    dispatch({ type: 'vault-detail', detail: null });
    dispatch({ type: 'recovery', detail: null });
    dispatch({ type: 'history', rows: [] });
    return undefined;
  }

  await loadVaultScoped(ctx, dispatch, address, identity);
  return address;
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
  const off = feed.subscribe((_keys, event) => {
    // Topic and type only. `WatchEvent.row` is the raw Postgres row and is
    // attacker-influenceable (§8 R10); it never enters the UI.
    dispatch({
      type: 'activity',
      entry: { at: ctx.now(), topic: event.topic, type: event.type, vault: '' },
    });
    onChange();
  });
  for (const address of plan.subscribed) {
    try {
      subs.push(
        ctx.qv.vault(address).watch((event: WatchEvent) => feed.push(address, event), {
          topics: ['transactions', 'confirmations', 'owners', 'recoveries'],
        }),
      );
    } catch {
      // A channel that will not open is a degraded refresh, not a dead UI.
    }
  }
  return {
    plan,
    close: async () => {
      off();
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

    // Ink and React load here and nowhere else. See the note at the top.
    const [ink, appModule, react] = await Promise.all([
      import('ink'),
      import('../tui/app.js'),
      import('react'),
    ]);

    const env: TuiEnv = {
      identity: ctx.identity() ?? '',
      contactName: (address) => ctx.contactName(address),
      now: () => ctx.now(),
      width: process.stdout.columns ?? 100,
    };

    let watching: { plan: ChannelPlan; close: () => Promise<void> } | undefined;
    let vaults: string[] = [];
    let redraw: (() => void) | undefined;
    /** The vault the cursor is on. Survives refreshes; drives the scoped panes. */
    let currentVault: string | undefined;

    const doRefresh = async (dispatch: Dispatch): Promise<void> => {
      try {
        currentVault = await refresh(
          ctx,
          dispatch,
          (found) => {
            vaults = found;
          },
          currentVault,
        );
        watching ??= subscribe(ctx, vaults, dispatch, () => redraw?.());
      } catch (err) {
        dispatch({ type: 'error', message: err instanceof Error ? err.message : 'load failed' });
      }
    };

    /** Vault cursor moved: repaint the three scoped panes, nothing else. */
    const onSelectVault = async (dispatch: Dispatch, address: string): Promise<void> => {
      currentVault = address;
      try {
        await loadVaultScoped(ctx, dispatch, address, ctx.identity() ?? '');
      } catch (err) {
        dispatch({ type: 'error', message: err instanceof Error ? err.message : 'load failed' });
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
      const outcome = await spawnSigner(argv);
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
        onSpawn,
      }),
      // btop/htop-style, and Ink's own option rather than hand-written escape
      // sequences: it knows to leave the alternate screen around a suspension
      // and to restore the primary screen on unmount, including on a signal.
      { exitOnCtrlC: true, alternateScreen: true },
    );

    try {
      await app.waitUntilExit();
    } finally {
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
