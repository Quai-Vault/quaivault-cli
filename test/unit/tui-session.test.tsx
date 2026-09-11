import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/tui/app.js';
import { FORM_FIELDS, initialState, type TuiState } from '../../src/tui/reducer.js';
import { ADDR, fakeTx } from '../fake-client.js';

const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); });
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function session(seed: TuiState, columns = 80, rows = 24) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref() {}, unref() {} });
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns, rows });
  const frames: string[] = [];
  stdout.on('data', (data: Buffer) => frames.push(stripVTControlCharacters(data.toString())));
  const onSpawn = vi.fn().mockResolvedValue({ ok: true, message: 'done' });
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  const onSelectVault = vi.fn().mockResolvedValue(undefined);
  const app = render(<App seed={seed} env={{ identity: ADDR.alice, width: columns, now: () => 1, contactName: () => undefined }} onSpawn={onSpawn} onRefresh={onRefresh} onSelectVault={onSelectVault} />, {
    stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true, interactive: true, exitOnCtrlC: false, patchConsole: false,
  });
  cleanup.push(() => { app.unmount(); app.cleanup(); stdin.destroy(); stdout.destroy(); });
  await settle();
  return { onSpawn, onRefresh, onSelectVault, stdout,
    frame: () => frames.findLast((f) => f.includes('QuaiVault')) ?? '',
    async key(input: string) { stdin.write(input); await settle(); },
  };
}

function seed(): TuiState {
  return { ...initialState(), vaults: [{ address: ADDR.vault, label: 'Treasury', pending: 1, hasRecovery: false }],
    rows: [{ vault: ADDR.vault, vaultLabel: 'Treasury', tx: fakeTx(), batch: null,
      affordances: [{ action: 'approve', allowed: true, reason: 'allowed' }] }],
    load: { status: 'ok' } };
}

describe('live Ink input and layout', () => {
  it('opens help, scrolls to its end, and never invokes hidden actions', async () => {
    const s = await session({ ...seed(), detail: true });
    await s.key('?');
    expect(s.frame()).toContain('Keyboard guide');
    await s.key('a');
    expect(s.onSpawn).not.toHaveBeenCalled();
    await s.key('\u001b[F');
    expect(s.frame()).toContain('Mouse selection stays available');
    await s.key('?');
    expect(s.frame()).toContain('Approvals');
  });

  it('keeps the footer and final detail lines reachable in a short window', async () => {
    const state = seed();
    state.detail = true;
    state.rows[0]!.tx.approvals = Array.from({ length: 30 }, (_, i) => ({ owner: `0x${String(i).padStart(40, '0')}`, active: true, confirmedAtBlock: i }));
    const s = await session(state, 60, 16);
    await s.key('\u001b[F');
    expect(s.frame()).toContain('0000000000000000000000000000000000000029');
    expect(s.frame()).toContain('q back');
    expect(s.frame().trimEnd().split('\n').length).toBeLessThanOrEqual(16);
  });

  it('edits policy r as text and does not refresh', async () => {
    const s = await session({ ...seed(), pane: 'policy', policy: [{ field: 'allow_to', value: '' }], policyEdit: '' });
    await s.key('r');
    expect(s.onRefresh).toHaveBeenCalledTimes(1);
    await s.key('\r');
    expect(s.onSpawn).toHaveBeenCalledWith(['policy', 'set', 'allow_to', 'r']);
  });

  it('requires Enter on the last field, including after bracketed paste', async () => {
    const s = await session({ ...seed(), pane: 'propose', form: { kind: 'transfer', field: 1, values: { to: ADDR.bob, amount: '1' } } });
    await s.key('\r');
    expect(s.onSpawn).not.toHaveBeenCalled();
    for (let i = 2; i < FORM_FIELDS.transfer.length - 1; i++) await s.key('\t');
    await s.key('\u001b[200~unique-key\n\u001b[201~');
    expect(s.onSpawn).not.toHaveBeenCalled();
    await s.key('\r');
    expect(s.onSpawn).toHaveBeenCalledWith(expect.arrayContaining(['--idempotency-key', 'unique-key']));
  });

  it('search owns action keys and clears without signing', async () => {
    const s = await session(seed());
    await s.key('/');
    await s.key('a');
    expect(s.frame()).toContain('Search: a');
    expect(s.onSpawn).not.toHaveBeenCalled();
    await s.key('\u001b');
    expect(s.frame()).not.toContain('Search:');
  });

  it('loads the first vault and responds to terminal resize', async () => {
    const s = await session(seed());
    expect(s.onSelectVault).toHaveBeenCalledWith(expect.any(Function), ADDR.vault);
    s.stdout.columns = 40;
    s.stdout.rows = 12;
    s.stdout.emit('resize');
    await settle();
    expect(s.frame().trimEnd().split('\n').length).toBeLessThanOrEqual(12);
    expect(s.frame()).toContain('QuaiVault');
    expect(s.frame()).toContain('q quit');
  });
});
