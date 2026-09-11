import { render } from 'ink';
import { App } from '../../src/tui/app.js';
import { initialState } from '../../src/tui/reducer.js';
import { spawnSigner, holdUntilAcknowledged } from '../../src/tui/spawn-signer.js';
import { ADDR, fakeTx } from '../fake-client.js';

if (process.argv.includes('--fixture-child')) {
  process.stdout.write('CHILD_REVIEW\nType the test word and Enter: ');
  process.stdin.once('data', (data) => {
    process.stdout.write(`CHILD_RECEIVED:${data.toString().trim()}\n`);
    process.exit(0);
  });
} else {
  const state = initialState();
  state.load = { status: 'ok', fetchedAt: 1800000000 };
  state.vaults = [{ address: ADDR.vault, label: 'Treasury 金庫', pending: 24, hasRecovery: true }];
  state.rows = Array.from({ length: 24 }, (_, i) => ({
    vault: ADDR.vault, vaultLabel: 'Treasury 金庫',
    tx: fakeTx({ hash: `0x${String(i).padStart(64, '0')}`, summary: `Proposal ${i + 1} · transfer QUAI`,
      approvals: Array.from({ length: 24 }, (_, j) => ({ owner: `0x${String(j).padStart(40, '0')}`, active: true, confirmedAtBlock: j })) }),
    affordances: [{ action: 'approve' as const, allowed: true, reason: 'allowed' }], batch: null,
  }));
  state.vaultDetail = { owners: [ADDR.alice, ADDR.bob], threshold: 2, minExecutionDelay: 0, modules: [], balanceWei: 12n * 10n ** 18n };
  const app = render(<App seed={state} env={{ identity: ADDR.alice, profile: 'mainnet', width: 80, contactName: () => undefined, now: () => 1800000000 }}
    onRefresh={() => Promise.resolve()}
    onSpawn={async (argv) => {
      const result = await spawnSigner(['--fixture-child', ...argv]);
      await holdUntilAcknowledged('\nPress any key to return.');
      return result;
    }} />, { alternateScreen: true, kittyKeyboard: { mode: 'auto' }, exitOnCtrlC: true });
  await app.waitUntilExit();
}
