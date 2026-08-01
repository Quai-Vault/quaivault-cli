import type { Affordance, VaultTransaction } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError, type AppContext } from '../context/context.js';
import { span } from '../format/tone.js';
import { abiSourceBadge, safeText } from '../format/index.js';
import { renderDisclosure } from '../render/transaction.js';
import { promptYesNo } from '../cli/confirm.js';
import { spawnSigner } from '../tui/spawn-signer.js';
import {
  initialState,
  reduce,
  selectedRow,
  visibleRows,
  type TuiRow,
} from '../tui/reducer.js';

/**
 * `qv tui` — a full-screen monitoring and review surface.
 *
 * It holds **no key** and can do nothing the one-shot surface cannot: every
 * write is a spawned `qv tx …` invocation. That makes the rule structural
 * rather than a convention.
 *
 * Bare `qv` never launches this — an agent must not land in a full-screen app
 * it cannot exit.
 */
async function loadRows(ctx: AppContext): Promise<{ rows: TuiRow[]; degraded: boolean }> {
  const identity = ctx.identity();
  if (!identity) throw new UsageError('No identity set.', 'qv use --as 0x…');
  const [owned, guardian, health] = await Promise.all([
    ctx.qv.vaults.forOwner(identity).catch(() => [] as string[]),
    ctx.qv.vaults.forGuardian(identity).catch(() => [] as string[]),
    ctx.qv.indexerHealth().catch(() => null),
  ]);
  const vaults = [...new Set([...owned, ...guardian])].slice(0, 25);
  const rows: TuiRow[] = [];
  await Promise.all(
    vaults.map(async (address) => {
      const vault = ctx.qv.vault(address);
      const pending = await vault.pendingTransactions({ limit: 50 }).catch(() => []);
      const affs = await Promise.all(
        pending.map((tx: VaultTransaction) =>
          vault.affordances(tx.hash, identity).catch(() => [] as Affordance[]),
        ),
      );
      pending.forEach((tx: VaultTransaction, i: number) => {
        rows.push({
          vault: address,
          vaultLabel: labelFor(ctx, address),
          tx,
          affordances: affs[i] ?? [],
        });
      });
    }),
  );
  return { rows, degraded: health?.available === false };
}

function labelFor(ctx: AppContext, address: string): string {
  const found = Object.entries(ctx.config.aliases).find(
    ([, v]) => v.toLowerCase() === address.toLowerCase(),
  );
  return found ? found[0] : `${address.slice(0, 8)}…`;
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

    let state = initialState(Math.max(5, (process.stdout.rows ?? 24) - 12));
    const io = ctx.io;

    const refresh = async (): Promise<void> => {
      state = reduce(state, { type: 'loading' });
      try {
        const { rows, degraded } = await loadRows(ctx);
        state = reduce(state, { type: 'data', rows, degraded, at: ctx.now() });
      } catch (err) {
        state = reduce(state, {
          type: 'error',
          message: err instanceof Error ? err.message : 'load failed',
        });
      }
    };

    const draw = (): void => {
      io.out('[2J[H');
      io.out(`QuaiVault — ${ctx.identity() ?? ''}`);
      io.out(
        state.pane.status === 'degraded'
          ? io.paint(span('indexer unavailable — this list is incomplete, not empty', 'danger'))
          : io.paint(span(`${state.rows.length} pending · ${state.pane.status}`, 'muted')),
      );
      io.out('');
      if (state.route === 'inbox') {
        const rows = visibleRows(state);
        rows.forEach((row, i) => {
          const idx = state.scroll + i;
          const marker = idx === state.selected ? '>' : ' ';
          const badge =
            row.tx.abiSource === 'builtin' ? '' : ` ${io.paint(abiSourceBadge(row.tx.abiSource))}`;
          io.out(
            `${marker} ${row.vaultLabel.padEnd(12)} ${row.tx.hash.slice(2, 10)}  ${row.tx.approvalCount}/${row.tx.threshold}  ${safeText(row.tx.summary, 44)}${badge}`,
          );
        });
        if (!rows.length) io.out('  Nothing waiting on you.');
        io.out('');
        io.out(io.paint(span('  j/k move · enter open · r refresh · q quit', 'muted')));
      } else {
        const row = selectedRow(state);
        if (row) {
          renderDisclosure(row.tx, io, ctx);
          io.out('');
          const canApprove = row.affordances.some((a) => a.action === 'approve' && a.allowed);
          const canExecute = row.affordances.some((a) => a.action === 'execute' && a.allowed);
          io.out(
            io.paint(
              span(
                `  ${canApprove ? 'a approve · ' : ''}${canExecute ? 'x execute · ' : ''}q back`,
                'muted',
              ),
            ),
          );
        }
      }
      if (state.lastSignResult) {
        io.out('');
        io.out(
          io.paint(
            span(
              `  ${state.lastSignResult.ok ? 'ok' : 'failed'}: ${state.lastSignResult.message}`,
              state.lastSignResult.ok ? 'ok' : 'danger',
            ),
          ),
        );
      }
    };

    await refresh();
    draw();

    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const restore = (): void => {
      stdin.setRawMode?.(false);
      stdin.pause();
      io.out('[2J[H');
    };

    await new Promise<void>((resolve) => {
      const onData = (chunk: string): void => {
        void (async () => {
          const key = decodeKey(chunk);
          if (key === 'r') {
            await refresh();
            draw();
            return;
          }
          if ((key === 'a' || key === 'x') && state.route === 'detail') {
            const row = selectedRow(state);
            if (!row) return;
            const action = key === 'a' ? 'approve' : 'execute';
            // Hand the terminal to a spawned one-shot signer, which reads its
            // own password from /dev/tty. Nothing here ever holds a key.
            stdin.setRawMode?.(false);
            io.out('[2J[H');
            const confirmed = await promptYesNo(`${action} ${row.tx.hash.slice(0, 10)}? [y/N] `);
            if (confirmed) {
              state = reduce(state, { type: 'sign-start', hash: row.tx.hash, action });
              const outcome = await spawnSigner(['tx', action, row.vault, row.tx.hash]);
              state = reduce(state, {
                type: 'sign-end',
                ok: outcome.ok,
                message: outcome.ok ? `${action} complete` : outcome.stderr.trim().slice(0, 200),
              });
              await refresh();
            }
            stdin.setRawMode?.(true);
            draw();
            return;
          }
          state = reduce(state, { type: 'key', key });
          if (state.quit) {
            stdin.off('data', onData);
            restore();
            resolve();
            return;
          }
          draw();
        })();
      };
      stdin.on('data', onData);
      process.once('SIGINT', () => {
        stdin.off('data', onData);
        restore();
        resolve();
      });
    });

    return { data: { exited: true as const }, changed: false };
  },

  render: () => undefined,
  toJson: () => ({ exited: true }),
  outputSchema: { type: 'object', properties: { exited: { type: 'boolean' } } },
};

function decodeKey(chunk: string): string {
  switch (chunk) {
    case '':
      return 'q';
    case '\r':
    case '\n':
      return 'return';
    case '':
      return 'escape';
    case '[A':
      return 'up';
    case '[B':
      return 'down';
    default:
      return chunk;
  }
}
