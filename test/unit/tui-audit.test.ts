import { describe, expect, it, vi } from 'vitest';
import { editText } from '../../src/tui/editor.js';
import { latestRequest } from '../../src/tui/requests.js';
import { fieldLimit, formArgv, initialForm, initialState, reduce, selectedRow, type TuiState } from '../../src/tui/reducer.js';
import { addressPages, historyPages, loadVaultScoped, pendingPages } from '../../src/commands/tui.js';
import { signerArgv } from '../../src/tui/spawn-signer.js';
import { mapKey, pastedText } from '../../src/tui/keys.js';
import { ADDR, createFakeContext, fakeTx } from '../fake-client.js';

const key = (s: TuiState, key: string) => reduce(s, { type: 'key', key });

describe('editing and terminal keys', () => {
  it('inserts and deletes at the cursor without corrupting Unicode code points', () => {
    expect(editText('a😀b', 1, '', 'x')).toEqual({ value: 'ax😀b', cursor: 2 });
    expect(editText('a😀b', 2, 'backspace')).toEqual({ value: 'ab', cursor: 1 });
    expect(editText('a😀b', 1, 'delete')).toEqual({ value: 'ab', cursor: 1 });
  });
  it('supports standard cursor and deletion shortcuts', () => {
    expect(editText('alpha beta', undefined, 'ctrl-w').value).toBe('alpha ');
    expect(editText('alpha beta', 5, 'ctrl-k').value).toBe('alpha');
    expect(editText('alpha', undefined, 'home').cursor).toBe(0);
    expect(editText('alpha', 0, 'end').cursor).toBe(5);
    expect(editText('alpha', 3, 'ctrl-u').value).toBe('');
  });
  it('does not mistake special keys or terminal escape sequences for paste', () => {
    expect(pastedText('garbage', { pageDown: true })).toBeNull();
    expect(pastedText('garbage', { meta: true })).toBeNull();
    expect(pastedText('\u001b[57362u', {})).toBeNull();
    expect(mapKey('', { pageUp: true })).toBe('page-up');
    expect(mapKey('', { home: true })).toBe('home');
    expect(mapKey('q', { meta: true })).toBeNull();
    expect(mapKey('\u007f', {})).toBeNull();
  });
  it('accepts real calldata and owner lists and rejects oversized typed input', () => {
    let s = { ...initialState(), pane: 'propose' as const, form: { ...initialForm('call'), field: 1 } };
    const data = `0x${'ab'.repeat(2048)}`;
    s = reduce(s, { type: 'paste', text: data }) as typeof s;
    expect(s.form.values.data).toBe(data);
    s.form.values.data = 'a'.repeat(fieldLimit('data'));
    s.form.cursor = undefined;
    expect(key(s, 'b').form.error).toContain('too long');
    const owners = Array(10).fill(ADDR.alice).join(',');
    const ownerForm = { ...initialState(), pane: 'propose' as const, form: { ...initialForm('create-vault'), field: 0 } };
    expect(reduce(ownerForm, { type: 'paste', text: owners }).form.values.owners).toBe(owners);
  });
  it('keeps policy paste and typing under the same limit, with visible errors', () => {
    const s = { ...initialState(), pane: 'policy' as const, policyEdit: 'a'.repeat(8192) };
    expect(key(s, 'a').policyError).toContain('too long');
    expect(reduce(s, { type: 'paste', text: 'a' }).policyError).toContain('too long');
  });
  it('requires explicit token decimals and forwards the chosen units', () => {
    const form = { ...initialForm('token'), values: { token: ADDR.token, to: ADDR.bob, amount: '1' } };
    expect(formArgv(form, ADDR.vault)).toBeNull();
    expect(formArgv({ ...form, values: { ...form.values, decimals: '6' } }, ADDR.vault)).toContain('--decimals');
  });
  it('builds ABI calls with timing and retry keys as literal argv', () => {
    const form = { ...initialForm('abi-call'), values: { to: ADDR.token, abi: '/tmp/my abi.json', function: 'transfer(address,uint256)', argsJson: '["x",1]', expiration: '7d', idempotencyKey: 'review-1' } };
    expect(formArgv(form, ADDR.vault)).toEqual(['propose', 'call', ADDR.vault, '--to', ADDR.token, '--abi', '/tmp/my abi.json', '--function', 'transfer(address,uint256)', '--args-json', '["x",1]', '--idempotency-key', 'review-1', '--expiration', '7d']);
  });
});

describe('selection and scroll safety', () => {
  function rows() {
    return [0, 1, 2].map((i) => ({ vault: ADDR.vault, vaultLabel: 'Treasury', tx: fakeTx({ hash: `0x${String(i).padStart(64, '0')}`, summary: `Proposal ${i}` }), affordances: [], batch: null }));
  }
  it('scrolls details without switching the transaction under review', () => {
    let s = reduce(initialState(5), { type: 'data', rows: rows(), degraded: false, at: 1 });
    s = key(s, 'return');
    s = reduce(s, { type: 'body-size', rows: 30 });
    s = key(s, 'page-down');
    expect(s.bodyScroll).toBe(5);
    expect(s.selected).toBe(0);
    s = key(s, 'end');
    expect(s.bodyScroll).toBe(25);
    expect(selectedRow(s)?.tx.summary).toBe('Proposal 0');
  });
  it('closes details when the reviewed transaction disappears', () => {
    let s = reduce(initialState(), { type: 'data', rows: rows(), degraded: false, at: 1 });
    s = key(s, 'return');
    s = reduce(s, { type: 'data', rows: rows().slice(1), degraded: false, at: 2 });
    expect(s.detail).toBe(false);
  });
  it('filters across hash, recipient, summary and vault label and anchors filtered selection', () => {
    let s = reduce(initialState(), { type: 'data', rows: rows(), degraded: false, at: 1 });
    s = key(s, '/');
    s = reduce(s, { type: 'paste', text: 'Proposal 1' });
    s = key(s, 'return');
    expect(selectedRow(s)?.tx.summary).toBe('Proposal 1');
    s = reduce(s, { type: 'data', rows: rows().reverse(), degraded: false, at: 2 });
    expect(selectedRow(s)?.tx.summary).toBe('Proposal 1');
    s = key(key(s, '/'), 'escape');
    expect(s.query).toBe('');
  });
  it('rejects late data and errors belonging to a different vault', () => {
    const s = { ...initialState(), vaults: [{ address: ADDR.vault, label: 'v', pending: 0, hasRecovery: false }] };
    expect(reduce(s, { type: 'history', address: ADDR.token, rows: rows() })).toBe(s);
    expect(reduce(s, { type: 'scoped-error', address: ADDR.token, message: 'old failure' })).toBe(s);
  });
  it('navigates all pending recoveries and preserves selection across refresh', () => {
    let s: TuiState = { ...initialState(), pane: 'recovery', vaults: [{ address: ADDR.vault, label: 'v', pending: 0, hasRecovery: true }] };
    const details = ['a', 'b'].map((hash) => ({ hash, newOwners: [], newThreshold: 1, approvals: 0, required: 1 }));
    s = reduce(s, { type: 'recoveries', address: ADDR.vault, details });
    s = key(s, 'right');
    expect(s.recovery?.hash).toBe('b');
    s = reduce(s, { type: 'recoveries', address: ADDR.vault, details: [...details].reverse() });
    expect(s.recovery?.hash).toBe('b');
    expect(s.recoveryIndex).toBe(0);
  });
  it('disarms recovery actions when the reviewed request disappears', () => {
    let s: TuiState = { ...initialState(), pane: 'recovery', vaults: [{ address: ADDR.vault, label: 'v', pending: 0, hasRecovery: true }] };
    const details = ['a', 'b'].map((hash) => ({ hash, newOwners: [], newThreshold: 1, approvals: 0, required: 1 }));
    s = reduce(s, { type: 'recoveries', address: ADDR.vault, details });
    s = reduce(s, { type: 'recoveries', address: ADDR.vault, details: details.slice(1) });
    expect(s.recovery).toBeNull();
    expect(s.recoveryIndex).toBe(-1);
    s = key(s, 'right');
    expect(s.recovery?.hash).toBe('b');
  });
});

describe('async data orchestration', () => {
  it('preserves the reviewed profile, identity and dry-run setting for delegated commands', () => {
    const argv = signerArgv(['tx', 'approve', ADDR.vault, 'hash'], {
      profile: 'orchard', identity: ADDR.alice, color: 'never', dryRun: true,
    });
    expect(argv).toEqual(['--profile', 'orchard', '--as', ADDR.alice, '--color', 'never', '--dry-run', 'tx', 'approve', ADDR.vault, 'hash']);
    expect(argv).not.toContain('--yes');
  });
  it('discovers vaults beyond the SDK default page and deduplicates addresses', async () => {
    const read = vi.fn((offset: number) => Promise.resolve(offset === 0 ? Array(100).fill(ADDR.vault) as string[] : [ADDR.vault.toLowerCase(), ADDR.token]));
    const result = await addressPages(read);
    expect(result.rows).toHaveLength(2);
    expect(read.mock.calls).toEqual([[0], [100]]);
  });
  it.each(['deposits', 'transfers', 'recoveries'] as const)('loads indexed %s in the selected history category', async (kind) => {
    const ctx = createFakeContext({ identity: ADDR.alice });
    const dispatch = vi.fn();
    await loadVaultScoped(ctx, dispatch, ADDR.vault, ADDR.alice, 50, kind);
    expect(dispatch).toHaveBeenCalledWith({ type: 'history-records', address: ADDR.vault, kind, page: { records: [], hasMore: false } });
    expect(dispatch).toHaveBeenCalledWith({ type: 'scoped-error', address: ADDR.vault, message: undefined });
  });
  it('discards superseded success, superseded failure, and post-close results', async () => {
    const emit = vi.fn();
    const loader = latestRequest<string>(emit);
    let finish!: () => void;
    const first = loader.run(async (send) => { await new Promise<void>((r) => { finish = r; }); send('old'); throw Error('old'); }, () => 'old error');
    await loader.run((send) => { send('new'); return Promise.resolve(); }, () => 'new error');
    finish(); await first;
    expect(emit.mock.calls).toEqual([['new']]);
    loader.close();
    await loader.run((send) => { send('closed'); return Promise.resolve(); }, () => 'error');
    expect(emit).toHaveBeenCalledTimes(1);
  });
  it('loads pending transactions beyond the first page and signals resource truncation', async () => {
    const page = (offset: number) => Array.from({ length: offset === 100 ? 3 : 100 }, (_, i) => fakeTx({ hash: `0x${String(offset + i).padStart(64, '0')}` }));
    const result = await pendingPages((offset) => Promise.resolve(page(offset)));
    expect(result.rows).toHaveLength(103);
    expect(result.truncated).toBe(false);
    const truncated = await pendingPages(() => Promise.resolve(page(0)));
    expect(truncated.truncated).toBe(true);
  });
  it('pages history past the SDK single-request limit without trusting total counts', async () => {
    const read = vi.fn((limit: number, offset: number) => Promise.resolve({ data: Array.from({ length: limit }, (_, i) => fakeTx({ hash: `0x${String(offset + i).padStart(64, '0')}` })), hasMore: true }));
    const result = await historyPages(read, 250);
    expect(result.data).toHaveLength(250);
    expect(read.mock.calls).toEqual([[100, 0], [100, 100], [50, 200]]);
    expect(result.hasMore).toBe(true);
  });
  it('loads history and recovery even when asset reads fail', async () => {
    const ctx = createFakeContext({ identity: ADDR.alice });
    const vault = ctx.qv.vault(ADDR.vault);
    vi.spyOn(vault, 'balances').mockRejectedValue(new Error('offline'));
    vi.spyOn(ctx.qv, 'vault').mockReturnValue(vault);
    const dispatch = vi.fn();
    await loadVaultScoped(ctx, dispatch, ADDR.vault, ADDR.alice);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'history', address: ADDR.vault }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'recoveries', address: ADDR.vault }));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'scoped-error', message: expect.stringContaining('Vault/assets') }));
  });
});
