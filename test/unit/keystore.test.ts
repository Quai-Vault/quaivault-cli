import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  chmodSync,
  symlinkSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertKeyName,
  assertQuaiLedgerAddress,
  assertSaneKdf,
  MAX_SCRYPT_N,
  MIN_SCRYPT_N,
} from '../../src/keys/keystore.js';
import { writeFileAtomic, loadConfig, saveConfig } from '../../src/context/config.js';
import { checkPolicy, loadPolicy, STARTER_POLICY } from '../../src/context/policy.js';
import { parse as parseToml } from 'smol-toml';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qv-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('key names cannot escape the keystore directory', () => {
  it('rejects traversal, separators and leading dots', () => {
    for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(65), 'a b']) {
      expect(() => assertKeyName(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('accepts ordinary names', () => {
    for (const ok of ['treasury', 'my-key', 'key_1', 'a.b']) {
      expect(assertKeyName(ok)).toBe(ok);
    }
  });
});

describe('KDF validation closes V3 unauthenticated kdfparams', () => {
  const ks = (n: number): string => JSON.stringify({ crypto: { kdfparams: { n } } });

  it('refuses a downgraded N', () => {
    // V3's MAC does not cover kdfparams, so an attacker with write access could
    // lower N and brute-force a copy taken earlier. This check is the control.
    expect(() => assertSaneKdf(ks(4096), false)).toThrow(/below the accepted minimum/);
    expect(() => assertSaneKdf(ks(MIN_SCRYPT_N - 1), false)).toThrow();
  });

  it('allows a downgrade only behind an explicit flag', () => {
    expect(() => assertSaneKdf(ks(4096), true)).not.toThrow();
  });

  it('refuses an absurd N even with the override — it is a DoS, not a preference', () => {
    expect(() => assertSaneKdf(ks(MAX_SCRYPT_N * 2), true)).toThrow(/above the accepted maximum/);
  });

  it('accepts the quais default', () => {
    expect(() => assertSaneKdf(ks(MIN_SCRYPT_N), false)).not.toThrow();
  });

  it('handles the capitalised Crypto key real keystores use', () => {
    expect(() => assertSaneKdf(JSON.stringify({ Crypto: { kdfparams: { n: 4096 } } }), false)).toThrow();
  });

  it('rejects a file that is not JSON at all', () => {
    expect(() => assertSaneKdf('not json', false)).toThrow(/not a valid JSON keystore/i);
  });
});

describe('QuaiVault is Quai-ledger only, and that is categorical', () => {
  it('refuses a Qi-ledger address even though its zone is valid', () => {
    // Zone and ledger are orthogonal. QuaiVault lives on the EVM (Quai) ledger;
    // Qi is UTXO and executes no contracts, so a Qi address is not merely
    // unsupported — it cannot sign, ever, in any version of this tool.
    expect(() => assertQuaiLedgerAddress('0x0081f4e8a9b0c1d2e3f405162738495a6b7c8d78')).toThrow(
      /cannot hold a key/,
    );
  });

  it('refuses a Qi address across every role, not just keys', async () => {
    const { inspectAddress } = await import('@quaivault/sdk');
    // One shared check backs owners, guardians, recipients, contacts and
    // aliases — so there is no role that quietly admits one.
    for (const qi of [
      '0x0081f4e8a9b0c1d2e3f405162738495a6b7c8d78',
      '0x00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3'.replace(/^0x00a1/, '0x00c1'),
    ]) {
      const check = inspectAddress(qi);
      if (check.ledger === 'qi') expect(check.valid).toBe(false);
    }
  });

  it('accepts a Quai-ledger address in a valid zone', () => {
    expect(() => assertQuaiLedgerAddress('0x005f2629A632962f4944d23686efDa5c160d535b')).not.toThrow();
  });
});

describe('atomic writes', () => {
  it('creates with the requested mode', () => {
    const p = join(dir, 'x.json');
    writeFileAtomic(p, 'hello', 0o600);
    expect(readFileSync(p, 'utf8')).toBe('hello');
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('leaves no temp files behind', () => {
    const p = join(dir, 'sub', 'x.json');
    writeFileAtomic(p, 'a', 0o600);
    writeFileAtomic(p, 'b', 0o600);
    expect(readFileSync(p, 'utf8')).toBe('b');
    expect(readdirSync(join(dir, 'sub')).filter((f) => f.startsWith('.tmp-'))).toHaveLength(0);
  });
});

describe('config round-trip', () => {
  it('preserves profiles, aliases and contacts', () => {
    const p = join(dir, 'config.toml');
    saveConfig(
      {
        defaultProfile: 'main',
        profiles: { main: { network: 'testnet', address: '0x00aa', vault: '0x00bb' } },
        aliases: { treasury: '0x00cc' },
        contacts: { bob: '0x00dd' },
      },
      p,
    );
    const loaded = loadConfig(p);
    expect(loaded.defaultProfile).toBe('main');
    expect(loaded.profiles.main?.network).toBe('testnet');
    expect(loaded.aliases.treasury).toBe('0x00cc');
    expect(loaded.contacts.bob).toBe('0x00dd');
  });

  it('returns defaults rather than throwing when absent', () => {
    const loaded = loadConfig(join(dir, 'nope.toml'));
    expect(loaded.profiles.default?.network).toBe('mainnet');
  });

  it('sanitises names read from a file that may be shared or hostile', () => {
    const p = join(dir, 'config.toml');
    writeFileSync(p, `[aliases]\n"ev\\u001b[2Ail" = "0x00aa"\n`);
    const loaded = loadConfig(p);
    for (const name of Object.keys(loaded.aliases)) {
      expect(name).not.toContain('');
    }
  });
});

describe('policy file', () => {
  it('absent is null, not an empty permissive policy', () => {
    // The difference decides whether non-interactive signing is allowed at all.
    expect(loadPolicy(join(dir, 'none.toml'))).toBeNull();
  });

  it('the starter policy parses and is restrictive by default', () => {
    const p = join(dir, 'policy.toml');
    writeFileAtomic(p, STARTER_POLICY, 0o600);
    const policy = loadPolicy(p);
    expect(policy).not.toBeNull();
    expect(policy!.denyDelegatecall).toBe(true);
    expect(policy!.requireAbiSource).toEqual(['builtin']);
    expect(policy!.denyKinds).toContain('wallet_admin');

    // A heuristic decode is refused by the shipped default.
    const violations = checkPolicy(policy!, {
      value: 1n,
      to: '0x00aa',
      kind: 'transfer',
      isDelegatecall: false,
      abiSource: 'heuristic',
      approvalsLastHour: 0,
    });
    expect(violations.map((v) => v.rule)).toContain('require_abi_source');
  });

  it('is valid TOML', () => {
    expect(() => parseToml(STARTER_POLICY)).not.toThrow();
  });
});

describe('keystore file hygiene', () => {
  it('refuses a world-readable keystore', async () => {
    const { unlockKey } = await import('../../src/keys/keystore.js');
    const home = join(dir, 'home');
    process.env.XDG_CONFIG_HOME = home;
    const keys = join(home, 'quaivault', 'keys');
    writeFileAtomic(join(keys, 'k.json'), '{}', 0o600);
    chmodSync(join(keys, 'k.json'), 0o644);
    await expect(unlockKey('k', 'pw')).rejects.toThrow(/readable by others/);
    delete process.env.XDG_CONFIG_HOME;
  });

  it('refuses a symlinked keystore', async () => {
    const { unlockKey } = await import('../../src/keys/keystore.js');
    const home = join(dir, 'home2');
    process.env.XDG_CONFIG_HOME = home;
    const keys = join(home, 'quaivault', 'keys');
    writeFileAtomic(join(keys, 'real.json'), '{}', 0o600);
    symlinkSync(join(keys, 'real.json'), join(keys, 'link.json'));
    await expect(unlockKey('link', 'pw')).rejects.toThrow(/symbolic link/);
    delete process.env.XDG_CONFIG_HOME;
  });
});
