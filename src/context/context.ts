import type { QuaiVaultClient } from '@quaivault/sdk';
import type { Signer } from 'quais';
import type { Io } from '../render/io.js';
import type { CliConfig, Profile } from './config.js';
import type { Policy } from './policy.js';
import type { SkewState } from './client.js';

export interface GlobalFlags {
  json: boolean;
  yes: boolean;
  noInput: boolean;
  quiet: boolean;
  debug: boolean;
  wide: boolean;
  color: 'auto' | 'always' | 'never';
  profile?: string;
  vault?: string;
  as?: string;
  dryRun: boolean;
  /** Required to sign anything whose decode is not `builtin`, or a delegatecall. */
  iUnderstandUnverified: boolean;
}

export interface AppContext {
  readonly qv: QuaiVaultClient;
  readonly config: CliConfig;
  readonly profile: Profile;
  readonly profileName: string;
  readonly flags: GlobalFlags;
  readonly io: Io;
  /** Skew-adjusted seconds. Absolute comparisons only — never durations. */
  readonly now: () => number;
  readonly skew: SkewState;
  /** `null` means no policy file exists. Not the same as an empty policy. */
  readonly policy: Policy | null;
  /** Can we prompt? Based on /dev/tty being openable, not stdin.isTTY. */
  readonly interactive: boolean;
  /** Resolve an alias or raw address to an address. */
  resolveVault(nameOrAddress: string | undefined): string;
  /** Reverse-resolve an address to a contact name, if known. */
  contactName(address: string): string | undefined;
  /** The identity acting — from --as, profile, or the active key. */
  identity(): string | undefined;
  /**
   * Unlock a signer for a write. Resolved lazily so that a read command never
   * touches the keystore, and released by the middleware on every exit path.
   */
  requireSigner(): Promise<{ signer: Signer; address: string }>;
}

export class UsageError extends Error {
  readonly code = 'VALIDATION';
  constructor(message: string, readonly remediation?: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export class PreconditionError extends Error {
  readonly code = 'PRECONDITION';
  constructor(message: string, readonly remediation?: string) {
    super(message);
    this.name = 'PreconditionError';
  }
}
