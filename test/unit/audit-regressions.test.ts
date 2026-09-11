import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSaneKdf } from '../../src/keys/keystore.js';
import { acquireSigningLock, resolveSigner } from '../../src/keys/signer.js';
import * as signers from '../../src/keys/signer.js';
import { configHome, loadConfig, writeFileAtomic } from '../../src/context/config.js';
import { loadPolicy, STARTER_POLICY } from '../../src/context/policy.js';
import { runCommand } from '../../src/cli/middleware.js';
import { createBufferIo } from '../../src/render/io.js';
import { createFakeContext } from '../fake-client.js';
import type { CommandSpec } from '../../src/cli/spec.js';
import { BroadcastError } from '@quaivault/sdk';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qv-audit-'));
  vi.stubEnv('XDG_CONFIG_HOME', dir);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });

const ADDRESS = '0x0011111111111111111111111111111111111111';
const scrypt = (over: Record<string, unknown> = {}) => JSON.stringify({ crypto: {
  kdf: 'scrypt', kdfparams: { n: 131072, r: 8, p: 1, dklen: 32, salt: 'ab'.repeat(32), ...over },
} });

describe('keystore CPU and memory limits', () => {
  it.each([{ p: 1_000_000 }, { r: 1_000_000 }, { n: 131073 }, { n: -1 }, { n: 1.5 }, { dklen: 1_000_000 }])('rejects unsafe parameters even with weak encryption accepted: %j', (params) => {
    expect(() => assertSaneKdf(scrypt(params), true)).toThrow();
  });
  it.each([1, 100_000_001])('bounds PBKDF2 iterations: %s', (c) => {
    const json = JSON.stringify({ crypto: { kdf: 'pbkdf2', kdfparams: { c, prf: 'hmac-sha256', dklen: 32, salt: 'ab'.repeat(32) } } });
    expect(() => assertSaneKdf(json, false)).toThrow();
  });
  it('validates mixed-case fields the same way as quais', () => {
    const json = scrypt({ p: 1_000_000 }).replace('crypto', 'CRYPTO').replace('kdfparams', 'KdfParams');
    expect(() => assertSaneKdf(json, true)).toThrow();
  });
  it.each(['null', '[]', '{}'])('rejects malformed keystore %s', (json) => {
    expect(() => assertSaneKdf(json, true)).toThrow();
  });
});

describe('policy configuration fails closed', () => {
  it.each([
    'max_value_per_approval_wei = 100',
    'max_approvals_per_hour = nan',
    'max_approvals_per_hour = -1',
    'max_approvals_per_hour = "5"',
    'allow_to = "0x0011111111111111111111111111111111111111"',
    'allow_to = [42]',
    'require_abi_source = ["bultin"]',
    'max_approval_per_hour = 5',
    'deny_delegatecall = "false"',
  ])('refuses an invalid bound: %s', (text) => {
    const path = join(dir, 'policy.toml'); writeFileSync(path, text);
    expect(() => loadPolicy(path)).toThrow();
  });
  it('does not silently interpret a misspelled testnet as mainnet', () => {
    const path = join(dir, 'config.toml'); writeFileSync(path, '[profiles.test]\nnetwork = "tesnet"');
    expect(() => loadConfig(path)).toThrow(/Invalid network/);
  });
});

describe('signing locks', () => {
  it('creates the config directory for first-time environment signing', () => {
    const lock = acquireSigningLock(ADDRESS); lock.release();
  });
  it('does not steal a lock just because a receipt takes over two minutes', () => {
    const lock = acquireSigningLock(ADDRESS);
    const path = join(configHome(), `.signing-${ADDRESS}.lock`);
    writeFileSync(path, `${process.pid}\n1\n`);
    expect(() => acquireSigningLock(ADDRESS)).toThrow(/Another qv/);
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe(`${process.pid}\n1\n`);
  });
  it('fails closed on a partially written lock', () => {
    const lock = acquireSigningLock(ADDRESS);
    writeFileSync(join(configHome(), `.signing-${ADDRESS}.lock`), '');
    expect(() => acquireSigningLock(ADDRESS)).toThrow();
    lock.release();
  });
  it('validates raw environment keys before acquiring a lock', async () => {
    vi.stubEnv('QUAIVAULT_PRIVATE_KEY_FILE', '');
    vi.stubEnv('QUAIVAULT_PRIVATE_KEY', '0x' + '0'.repeat(63) + '1');
    await expect(resolveSigner({ network: 'mainnet' }, undefined, false)).rejects.toThrow(/cannot hold a key/);
  });
});

it('honors the environment identity when checking the unlocked signer', async () => {
  vi.stubEnv('QUAIVAULT_ADDRESS', ADDRESS);
  writeFileAtomic(join(configHome(), 'policy.toml'), STARTER_POLICY);
  const release = vi.fn();
  vi.spyOn(signers, 'resolveSigner').mockResolvedValue({ address: '0x0033333333333333333333333333333333333333', signer: {} as never, release });
  const commit = vi.fn();
  const spec: CommandSpec = {
    path: ['audit-write'], describe: 'test', needs: { signer: true },
    plan: () => Promise.resolve({ disclosure: {}, summary: 'test' }), commit,
    render() {}, toJson: () => ({}), outputSchema: {},
  };
  const io = createBufferIo();
  const code = await runCommand({ spec, input: {}, flags: { ...createFakeContext().flags, yes: true, json: true }, io });
  expect(code).toBe(3);
  expect(commit).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(io.stdout.join('')).toContain('acting as');
});

it('cannot overwrite a concurrently imported key', () => {
  const path = join(dir, 'key.json');
  writeFileAtomic(path, 'original key', 0o600, true);
  expect(() => writeFileAtomic(path, 'replacement key', 0o600, true)).toThrow();
  expect(readFileSync(path, 'utf8')).toBe('original key');
});

it('reports a submitted transaction as unknown in the JSON protocol', async () => {
  const hash = '0x' + 'ab'.repeat(32);
  const spec: CommandSpec = {
    path: ['audit-unknown'], describe: 'test',
    run: () => Promise.reject(new BroadcastError(hash)),
    render() {}, toJson: () => ({}), outputSchema: {},
  };
  const io = createBufferIo();
  const code = await runCommand({ spec, input: {}, flags: { ...createFakeContext().flags, json: true }, io });
  expect(code).toBe(1);
  expect(JSON.parse(io.stdout.join(''))).toMatchObject({
    ok: false, changed: 'unknown', retryable: false,
    data: { chainTxHash: hash }, error: { code: 'BROADCAST_UNKNOWN', chainTxHash: hash },
  });
});

it('does not expose invalid private scalars from the environment', async () => {
  const key = '0x' + 'ff'.repeat(32);
  vi.stubEnv('QUAIVAULT_PRIVATE_KEY_FILE', '');
  vi.stubEnv('QUAIVAULT_PRIVATE_KEY', key);
  const error: unknown = await resolveSigner({ network: 'mainnet' }, undefined, false).catch((e: unknown) => e);
  expect(String(error)).not.toContain(key.slice(2));
  expect(String(error)).toContain('secp256k1');
});
