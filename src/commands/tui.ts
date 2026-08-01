import type { Affordance, Subscription, VaultTransaction, WatchEvent } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
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
 * One refresh. The cross-vault inbox lands first so the default pane paints,
 * then the slower per-vault reads for the other panes.
 */
async function refresh(
  ctx: AppContext,
  dispatch: Dispatch,
  vaultsOut: (vaults: string[]) => void,
): Promise<void> {
  const identity = ctx.identity();
  if (!identity) throw new UsageError('No identity set.', 'qv use --as 0x…');
  dispatch({ type: 'loading' });

  const [vaults, health] = await Promise.all([
    loadVaults(ctx, identity),
    ctx.qv.indexerHealth().catch(() => null),
  ]);
  vaultsOut(vaults);
  const degraded = health?.available === false;

  const summaries: VaultSummary[] = [];
  const inbox: TuiRow[] = [];
  await Promise.all(
    vaults.map(async (address) => {
      const vault = ctx.qv.vault(address);
      const [pending, hasRecovery] = await Promise.all([
        vault.pendingTransactions({ limit: 50 }).catch((): VaultTransaction[] => []),
        vault.recovery.hasPending().catch(() => false),
      ]);
      summaries.push({
        address,
        label: labelFor(ctx, address),
        pending: pending.length,
        hasRecovery,
      });
      inbox.push(...(await rowsFor(ctx, address, identity, pending)));
    }),
  );

  dispatch({ type: 'vaults', vaults: summaries });
  dispatch({ type: 'data', rows: inbox, degraded, at: ctx.now() });

  const address = vaults[0];
  if (!address) {
    dispatch({ type: 'vault-detail', detail: null });
    dispatch({ type: 'recovery', detail: null });
    dispatch({ type: 'history', rows: [] });
    return;
  }

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

/** Subscribe within the channel budget; events become staleness and activity. */
function subscribe(
  ctx: AppContext,
  vaults: readonly string[],
  dispatch: Dispatch,
  onChange: () => void,
): { plan: ChannelPlan; close: () => void } {
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
    close: () => {
      off();
      for (const sub of subs) {
        try {
          void sub.unsubscribe();
        } catch {
          // Teardown races process exit; nothing useful to do.
        }
      }
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

    let watching: { plan: ChannelPlan; close: () => void } | undefined;
    let vaults: string[] = [];
    let redraw: (() => void) | undefined;
    const frame: { clear?: () => void } = {};

    const doRefresh = async (dispatch: Dispatch): Promise<void> => {
      try {
        await refresh(ctx, dispatch, (found) => {
          vaults = found;
        });
        watching ??= subscribe(ctx, vaults, dispatch, () => redraw?.());
      } catch (err) {
        dispatch({ type: 'error', message: err instanceof Error ? err.message : 'load failed' });
      }
    };

    /**
     * Hand the terminal over (§4.4, "drops raw mode, leaves the screen,
     * spawns"). Ink's last frame is erased first so its diff is not fighting
     * the child's output; the next state change redraws below it.
     */
    const onSpawn = async (argv: string[]): Promise<{ ok: boolean; message: string }> => {
      frame.clear?.();
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
        onSpawn,
      }),
      { exitOnCtrlC: true },
    );
    frame.clear = () => app.clear();

    try {
      await app.waitUntilExit();
    } finally {
      watching?.close();
    }

    return { data: { exited: true as const }, changed: false };
  },

  render: () => undefined,
  toJson: () => ({ exited: true }),
  outputSchema: { type: 'object', properties: { exited: { type: 'boolean' } } },
};
