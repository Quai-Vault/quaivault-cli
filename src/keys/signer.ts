import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBytes, SigningKey, Wallet, type Signer } from 'quais';
import { configHome } from '../context/config.js';
import { PreconditionError, UsageError } from '../context/context.js';
import type { Profile } from '../context/config.js';
import { unlockKey } from './keystore.js';
import { readPassword, resolvePasswordSource } from './password.js';

export interface SignerResolution {
  signer: Signer;
  address: string;
  release(): void;
}

/**
 * Build a signer for a write.
 *
 * Precedence is explicit and there is **no silent fallback** between levels:
 * if a named keystore cannot be unlocked we fail, rather than quietly signing
 * with whatever is in the environment. Signing as the wrong owner is a
 * fund-loss bug, not a UX quirk.
 *
 *   1. the profile's active keystore key
 *   2. QUAIVAULT_PRIVATE_KEY_FILE
 *   3. QUAIVAULT_PRIVATE_KEY  (documented as least preferred)
 */
export async function resolveSigner(
  profile: Profile,
  provider: unknown,
  interactive: boolean,
): Promise<SignerResolution> {
  if (profile.key) {
    const source = resolvePasswordSource(interactive);
    const password = await readPassword(source, `Password for key "${profile.key}": `);
    const unlocked = await unlockKey(profile.key, password);
    const lock = acquireSigningLock(unlocked.address);
    return {
      signer: unlocked.signer(provider as never),
      address: unlocked.address,
      release: () => {
        unlocked.dispose();
        lock.release();
      },
    };
  }

  const keyFile = process.env.QUAIVAULT_PRIVATE_KEY_FILE;
  const raw = keyFile
    ? readFileSync(keyFile, 'utf8').trim()
    : (process.env.QUAIVAULT_PRIVATE_KEY ?? '').trim();

  if (!raw) {
    throw new PreconditionError(
      'This command signs a transaction and no key is configured.',
      'qv key import <name> --use   ·   or set QUAIVAULT_PRIVATE_KEY_FILE for CI.',
    );
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new UsageError('The configured private key is not 32 bytes of hex.');
  }

  const bytes = getBytes(raw.startsWith('0x') ? raw : `0x${raw}`);
  const signingKey = new SigningKey(bytes);
  bytes.fill(0);
  const wallet = new Wallet(signingKey, provider as never);
  const lock = acquireSigningLock(wallet.address);
  return { signer: wallet, address: wallet.address, release: () => lock.release() };
}

/**
 * Advisory lock on (network, signer address), held only across sign-and-
 * broadcast.
 *
 * Two agents approving concurrently with one key is a **nonce collision**: both
 * pass the affordance check, both broadcast, one gets replaced, and the CLI
 * reports something incoherent. The SDK offers no help — it never retries
 * writes by design.
 *
 * **Fails fast rather than blocking.** An agent that blocks is worse than one
 * that retries with a clear reason.
 */
export interface SigningLock {
  release(): void;
}

const STALE_LOCK_MS = 120_000;

export function acquireSigningLock(address: string): SigningLock {
  const path = join(configHome(), `.signing-${address.toLowerCase()}.lock`);
  const tryOpen = (): number | null => {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  let fd = tryOpen();
  if (fd === null) {
    // A crashed invocation leaves a lock behind; treat an old one as dead.
    let stale = false;
    try {
      const age = Date.now() - Number(readFileSync(path, 'utf8').split('\n')[1] ?? 0);
      stale = Number.isFinite(age) && age > STALE_LOCK_MS;
    } catch {
      stale = true;
    }
    if (!stale) {
      throw new PreconditionError(
        `Another qv invocation is signing with ${address}.`,
        'Concurrent signing with one key collides on the nonce. Retry when it finishes.',
      );
    }
    try {
      unlinkSync(path);
    } catch {
      /* raced with the holder exiting; fall through */
    }
    fd = tryOpen();
    if (fd === null) {
      throw new PreconditionError(`Another qv invocation is signing with ${address}.`);
    }
  }

  try {
    writeFileSync(fd, `${process.pid}\n${Date.now()}\n`);
  } catch {
    /* best effort */
  } finally {
    closeSync(fd);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  return { release };
}
