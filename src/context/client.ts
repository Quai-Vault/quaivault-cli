import { connect } from '@quaivault/sdk';
import type { QuaiVaultClient, Clock } from '@quaivault/sdk';
import type { Signer } from 'quais';
import type { Profile } from './config.js';

/**
 * The only module that calls `connect()`.
 *
 * Keeping it to one call site is what makes the typed fake in tests viable and
 * bounds the blast radius when the SDK changes shape.
 */
export interface ClientOptions {
  profile: Profile;
  now: Clock;
  signer?: Signer;
}

export function createClient(opts: ClientOptions): QuaiVaultClient {
  const network = opts.profile.network;
  return connect({
    network,
    // **Never read the environment.** The SDK reads env by default and only
    // skips private-key resolution when a signer is passed — so a keyless
    // command like `qv inbox` would otherwise pull an exported
    // QUAIVAULT_PRIVATE_KEY into ResolvedConfig for a command that will never
    // sign (plan §3.5). The CLI owns config resolution anyway.
    useEnv: false,
    now: opts.now,
    ...(opts.signer ? { signer: opts.signer } : {}),
    ...(opts.profile.rpcUrl ? { rpcUrl: opts.profile.rpcUrl } : {}),
  });
}

/**
 * Clock skew detection (plan §2.1). Compensation is the SDK's job via
 * `ClientOptions.now`; deriving the offset is ours.
 *
 * Positive offset = local clock is ahead of chain.
 */
export interface SkewState {
  offsetSeconds: number;
  detected: boolean;
}

export function createClock(state: SkewState): Clock {
  return () => Math.floor(Date.now() / 1000) - (state.detected ? state.offsetSeconds : 0);
}

export const SKEW_WARN_THRESHOLD_SECONDS = 60;
