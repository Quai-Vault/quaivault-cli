import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findOperation, reserveOperation, recordOperation } from '../../src/context/operation-journal.js';
import {
  recentPolicyActionCount,
  recordPolicyAction,
  reservePolicyAction,
} from '../../src/context/policy-journal.js';

describe('durable agent journals', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qv-journal-'));
    vi.stubEnv('XDG_CONFIG_HOME', root);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('reserves an idempotency key before submission and fails closed after a crash', () => {
    const record = { at: 1, profile: 'default', key: 'one', fingerprint: 'abc', command: 'propose send', vault: 'v', transactionHash: '', chainTxHash: '' };
    expect(reserveOperation(record)).toBeUndefined();
    expect(() => findOperation('default', 'one')).toThrow(/unresolved submission/);
    expect(() => reserveOperation(record)).toThrow(/unresolved submission/);
    recordOperation({ ...record, transactionHash: 'tx', chainTxHash: 'chain' });
    expect(findOperation('default', 'one')?.chainTxHash).toBe('chain');
  });

  it('reserves the final approval slot before a receipt can time out', () => {
    const entry = { at: 10000, profile: 'default', action: 'approve', vault: 'v', transactionHash: 'tx', chainTxHash: '' };
    reservePolicyAction(entry, 1);
    expect(() => reservePolicyAction({ ...entry, transactionHash: 'other' }, 1)).toThrow(/budget/);
    expect(recentPolicyActionCount('default', 'approve', 10001)).toBe(1);
  });

  it('reconciles idempotency keys only within their profile' , () => {
    recordOperation({
      at: 1_800_000_000,
      profile: 'agent-a',
      key: 'payout-17',
      fingerprint: 'abc',
      command: 'propose send',
      vault: '0xvault',
      transactionHash: '0xtx',
      chainTxHash: '0xchain',
    });

    expect(findOperation('agent-a', 'payout-17')?.transactionHash).toBe('0xtx');
    expect(findOperation('agent-b', 'payout-17')).toBeUndefined();
    expect(statSync(join(root, 'quaivault', 'operations.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('fails closed when the operation journal is corrupt', () => {
    recordOperation({
      at: 1,
      profile: 'default',
      key: 'key',
      fingerprint: 'abc',
      command: 'propose send',
      vault: '0xvault',
      transactionHash: '0xtx',
      chainTxHash: '0xchain',
    });
    const path = join(root, 'quaivault', 'operations.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}not-json\n`, 'utf8');
    expect(() => findOperation('default', 'key')).toThrow(/corrupt/);
  });

  it('counts only matching successful unattended actions from the last hour', () => {
    recordPolicyAction({
      at: 10_000,
      profile: 'default',
      action: 'approve',
      vault: '0xvault',
      transactionHash: '0xtx1',
      chainTxHash: '0xchain1',
    });
    recordPolicyAction({
      at: 5_000,
      profile: 'default',
      action: 'approve',
      vault: '0xvault',
      transactionHash: '0xtx2',
      chainTxHash: '0xchain2',
    });
    recordPolicyAction({
      at: 10_100,
      profile: 'other',
      action: 'approve',
      vault: '0xvault',
      transactionHash: '0xtx3',
      chainTxHash: '0xchain3',
    });

    expect(recentPolicyActionCount('default', 'approve', 10_200)).toBe(1);
  });

  it('fails closed when rate-limit history is corrupt', () => {
    recordPolicyAction({
      at: 10_000,
      profile: 'default',
      action: 'approve',
      vault: '0xvault',
      transactionHash: '0xtx',
      chainTxHash: '0xchain',
    });
    const path = join(root, 'quaivault', 'policy-actions.jsonl');
    writeFileSync(path, `${readFileSync(path, 'utf8')}{}\n`, 'utf8');
    expect(() => recentPolicyActionCount('default', 'approve', 10_100)).toThrow(/corrupt/);
  });
});
