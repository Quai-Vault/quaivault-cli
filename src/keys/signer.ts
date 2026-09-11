import { openSync, closeSync, unlinkSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { getBytes, SigningKey, Wallet, type Signer } from 'quais';
import { configHome } from '../context/config.js';
import { PreconditionError, UsageError } from '../context/context.js';
import type { Profile } from '../context/config.js';
import { unlockKey, assertQuaiLedgerAddress } from './keystore.js';
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
  let wallet: Wallet;
  try {
    wallet = new Wallet(new SigningKey(bytes), provider as never);
  } catch {
    throw new UsageError('The configured private key is not a valid secp256k1 key.');
  } finally { bytes.fill(0); }
  assertQuaiLedgerAddress(wallet.address);
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

export function acquireSigningLock(address: string): SigningLock {
  mkdirSync(configHome(), { recursive: true, mode: 0o700 });
  const path = join(configHome(), `.signing-${address.toLowerCase()}.lock`);
  const tryOpen = (): number | null => {
    try {
      return openSync(path, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
      throw err;
    }
  };

  const fd = tryOpen();
  if (fd === null) {
    // A slow receipt is not a dead process. Automatic unlink/reopen also races
    // between contenders, allowing both to sign. Fail closed for abandoned locks.
    throw new PreconditionError(
      `Another qv invocation may be signing with ${address}.`,
      `Retry when it finishes. If it crashed, verify its PID and pending transactions before manually removing ${path}.`,
    );
  }

  const token = `${process.pid}\n${Date.now()}\n${randomUUID()}\n`;
  try {
    writeFileSync(fd, token);
  } catch (err) {
    unlinkSync(path);
    throw err;
  } finally {
    closeSync(fd);
  }

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(path, 'utf8') === token) unlinkSync(path);
    } catch {
      /* already gone */
    }
  };
  return { release };
}
