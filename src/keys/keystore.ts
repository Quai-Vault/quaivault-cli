import { readFileSync, readdirSync, lstatSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  encryptKeystoreJson,
  decryptKeystoreJson,
  isKeystoreJson,
  SigningKey,
  Wallet,
  getBytes,
  type Provider,
  type Signer,
} from 'quais';
import { inspectAddress } from '@quaivault/sdk';
import { configHome, writeFileAtomic } from '../context/config.js';
import { UsageError, PreconditionError } from '../context/context.js';

/**
 * Key storage is **Web3 Secret Storage V3, via quais**. We do not design a
 * keystore format (plan §3.3).
 *
 * quais already ships `encryptKeystoreJson`/`decryptKeystoreJson`, implementing
 * a decade-scrutinised standard that every wallet in the ecosystem can read,
 * with **zero new dependencies**. Its default is scrypt N=2^17 — the
 * interop-safe floor, not the notoriously weak N=4096 "light" preset.
 *
 * Keystore files are untrusted inputs. Bound every KDF cost before deriving,
 * both to refuse weak encryption and to prevent excessive memory or CPU use.
 * Changing KDF parameters on an existing file does not reduce the work needed
 * to decrypt its ciphertext: the derived key and MAC would no longer match.
 */

/** Below this, a keystore is cheap enough to brute-force. */
export const MIN_SCRYPT_N = 1 << 17;
/** Above this, a tampered file can force ~1 GiB and an unbounded CPU burn. */
export const MAX_SCRYPT_N = 1 << 20;

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

export function keysDir(): string {
  return join(configHome(), 'keys');
}

export function keyPath(name: string): string {
  return join(keysDir(), `${assertKeyName(name)}.json`);
}

export function assertKeyName(name: string): string {
  if (!NAME_RE.test(name) || name.startsWith('.')) {
    throw new UsageError(
      `Invalid key name ${JSON.stringify(name)}.`,
      'Letters, digits, dot, underscore and hyphen only, up to 64 characters, not starting with a dot.',
    );
  }
  return name;
}

export interface KeyEntry {
  name: string;
  address: string;
  path: string;
}

/**
 * Refuse to read a keystore whose permissions or type are wrong.
 *
 * A symlinked keystore path is a write primitive; a group- or world-readable
 * key file is a key someone else has.
 */
function assertSafeFile(path: string): void {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new PreconditionError(
      `Refusing to use ${path}: it is a symbolic link.`,
      'Replace it with a real file.',
    );
  }
  if (!st.isFile()) throw new PreconditionError(`Refusing to use ${path}: not a regular file.`);
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new PreconditionError(
      `Refusing to use ${path}: mode ${mode.toString(8).padStart(3, '0')} is readable by others.`,
      `Run: chmod 600 ${path}`,
    );
  }
}

function assertSafeDir(): string {
  const dir = keysDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = statSync(dir);
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new PreconditionError(
      `Refusing to use ${dir}: mode ${mode.toString(8)} is accessible by others.`,
      `Run: chmod 700 ${dir}`,
    );
  }
  return dir;
}

/**
 * Validate KDF parameters **before** deriving anything.
 *
 * This is the control that closes V3's unauthenticated-params hole, and it is
 * also a DoS guard: quais' only backstop is a 1 GiB `maxmem`.
 */
export function assertSaneKdf(json: string, allowWeak: boolean): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new UsageError('Not a valid JSON keystore.');
  }
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new UsageError('Invalid keystore KDF parameters.');
    }
    // quais reads keystore fields case-insensitively. Validate the same fields,
    // and reject ambiguous spellings instead of checking a different KDF.
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      const lower = key.toLowerCase();
      if (Object.hasOwn(out, lower)) throw new UsageError('Ambiguous keystore fields.');
      out[lower] = value;
    }
    return out;
  };
  const crypto = record(record(parsed).crypto);
  const params = record(crypto.kdfparams);
  const integer = (name: string): number => {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new UsageError(`Invalid keystore KDF parameter ${name}.`);
    }
    return value;
  };
  if (integer('dklen') !== 32) throw new UsageError('Keystore dklen must be 32.');
  if (typeof params.salt !== 'string' || !/^(?:[0-9a-f]{2}){16,64}$/i.test(params.salt)) {
    throw new UsageError('Keystore KDF salt must contain 16 to 64 bytes of hex.');
  }
  const kdf = typeof crypto.kdf === 'string' ? crypto.kdf.toLowerCase() : '';
  if (kdf === 'scrypt') {
    const n = integer('n');
    const r = integer('r');
    const p = integer('p');
    if (n > MAX_SCRYPT_N) {
      throw new PreconditionError(`Keystore declares scrypt N=${n}, above the accepted maximum of ${MAX_SCRYPT_N}.`);
    }
    if (!Number.isInteger(Math.log2(n))) throw new UsageError('scrypt N must be a power of two.');
    if (r > 32 || p > 16 || n * r > MAX_SCRYPT_N * 8 || n * r * p > MAX_SCRYPT_N * 8) {
      throw new PreconditionError('Keystore scrypt parameters exceed the memory or CPU budget.');
    }
    if (!allowWeak && (n < MIN_SCRYPT_N || r < 8)) {
      throw new PreconditionError(
        'Keystore scrypt cost is below the accepted minimum.',
        'Re-encrypt with `qv key change-password`, or explicitly accept a weak KDF at import.',
      );
    }
  } else if (kdf === 'pbkdf2') {
    const c = integer('c');
    const prf = typeof params.prf === 'string' ? params.prf.toLowerCase() : '';
    if (prf !== 'hmac-sha256' && prf !== 'hmac-sha512') throw new UsageError('Unsupported PBKDF2 PRF.');
    if (c > 10_000_000) throw new PreconditionError('Keystore PBKDF2 cost exceeds the CPU budget.');
    if (!allowWeak && c < 600_000) throw new PreconditionError('Keystore PBKDF2 cost is below the accepted minimum of 600000 iterations.');
  } else {
    throw new UsageError('Unsupported keystore KDF.');
  }
}

export function listKeys(): KeyEntry[] {
  let dir: string;
  try {
    dir = assertSafeDir();
  } catch {
    return [];
  }
  const out: KeyEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const name = file.slice(0, -5);
    const path = join(dir, file);
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as { address?: string };
      out.push({
        name,
        address: parsed.address ? normalizeStoredAddress(parsed.address) : '(unknown)',
        path,
      });
    } catch {
      out.push({ name, address: '(unreadable)', path });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeStoredAddress(address: string): string {
  return address.startsWith('0x') ? address : `0x${address}`;
}

export function keyExists(name: string): boolean {
  try {
    lstatSync(keyPath(name));
    return true;
  } catch {
    return false;
  }
}

/** Encrypt raw key bytes to a V3 keystore and write it atomically. */
export async function saveKey(name: string, privateKey: Uint8Array, password: string): Promise<KeyEntry> {
  assertSafeDir();
  const path = keyPath(name);
  if (keyExists(name)) {
    throw new UsageError(
      `A key named ${JSON.stringify(name)} already exists.`,
      'Remove it first with `qv key rm`, or choose another name. This command never overwrites.',
    );
  }
  const signingKey = new SigningKey(privateKey);
  const wallet = new Wallet(signingKey);
  const address = await wallet.getAddress();
  // quais defaults to scrypt N=2^17, which is the interop-safe floor. Accept it
  // rather than hand-tuning a security parameter.
  const json = await encryptKeystoreJson(
    { address, privateKey: signingKey.privateKey },
    password,
  );
  writeFileAtomic(path, `${json}\n`, 0o600, true);
  return { name, address, path };
}

export interface UnlockedKey {
  address: string;
  /** Build a signer bound to a provider. */
  signer(provider: Provider): Signer;
  /** Zero the key material we hold. */
  dispose(): void;
}

/**
 * Decrypt a keystore and build a signer **from bytes**.
 *
 * `new SigningKey(bytes)` then `new Wallet(key, provider)` — never
 * `connect({ privateKey })`. `getBytes` does not copy a `Uint8Array`, so
 * zeroing our buffer is genuinely effective for that buffer.
 *
 * Honest limit: `SigningKey` stores the key as an immutable hex string and
 * re-parses it on every signature, producing copies no zeroing can reach. This
 * prevents the config-dump leak class; it does not defeat a heap dump.
 */
export async function unlockKey(
  name: string,
  password: string,
  opts: { allowWeakKdf?: boolean } = {},
): Promise<UnlockedKey> {
  const path = keyPath(name);
  try {
    assertSafeFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new UsageError(`No key named ${JSON.stringify(name)}.`, 'List keys with `qv key ls`.');
    }
    throw err;
  }
  const json = readFileSync(path, 'utf8');
  if (!isKeystoreJson(json)) {
    throw new UsageError(`${path} is not a Web3 Secret Storage keystore.`);
  }
  assertSaneKdf(json, opts.allowWeakKdf === true);

  let account;
  try {
    account = await decryptKeystoreJson(json, password);
  } catch {
    // Do not distinguish "bad password" from "corrupt file" any more than the
    // underlying error already does — and never echo the password.
    throw new PreconditionError(
      'Could not decrypt the keystore.',
      'Wrong password, or the file is damaged.',
    );
  }

  const bytes = getBytes(account.privateKey);
  const signingKey = new SigningKey(bytes);
  const address = new Wallet(signingKey).address;
  assertQuaiLedgerAddress(address);
  // Zero the buffer we own. See the honest limit above for what this does not cover.
  bytes.fill(0);

  return {
    address,
    signer: (provider: Provider) => new Wallet(signingKey, provider),
    dispose: () => {
      /* SigningKey holds an immutable hex string; nothing further to zero. */
    },
  };
}

/**
 * Assert an address can participate in a QuaiVault at all.
 *
 * QuaiVault lives on the **Quai ledger**, which is the EVM side of the network.
 * The Qi ledger is UTXO and executes no contracts, so a Qi address is not
 * "unsupported" here — it is categorically incapable of signing, approving, or
 * holding a role in a vault. There is no version of this tool that changes
 * that.
 *
 * **Zone and ledger are orthogonal and both must hold**, which is why this
 * calls `inspectAddress` rather than `getZoneForAddress`: `0x0081…` sits in a
 * real zone and is still Qi. Checking only the zone is how a Qi key gets into a
 * keystore and is discovered mid-signature.
 *
 * Enforced at import, not at first use.
 */
export function assertQuaiLedgerAddress(address: string): void {
  const check = inspectAddress(address);
  if (!check.valid) {
    throw new UsageError(
      `${address} cannot hold a key for a QuaiVault.`,
      `zone ${check.zone ?? '?'} · ledger ${check.ledger ?? '?'} — ${check.reason ?? 'invalid'}`,
    );
  }
}

export function removeKey(name: string): void {
  const path = keyPath(name);
  if (!keyExists(name)) {
    throw new UsageError(`No key named ${JSON.stringify(name)}.`);
  }
  unlinkSync(path);
}

export function readKeystoreJson(name: string): string {
  const path = keyPath(name);
  assertSafeFile(path);
  return readFileSync(path, 'utf8');
}

export async function reencrypt(
  name: string,
  oldPassword: string,
  newPassword: string,
): Promise<void> {
  const json = readKeystoreJson(name);
  assertSaneKdf(json, true);
  const account = await decryptKeystoreJson(json, oldPassword).catch(() => {
    throw new PreconditionError('Could not decrypt the keystore.', 'Wrong password?');
  });
  // A fresh salt and IV come from a fresh encrypt — never reuse either.
  const next = await encryptKeystoreJson(
    { address: account.address, privateKey: account.privateKey },
    newPassword,
  );
  writeFileAtomic(keyPath(name), `${next}\n`, 0o600);
}
