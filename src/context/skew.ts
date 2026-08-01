import type { QuaiVaultClient } from '@quaivault/sdk';
import { getZoneForAddress, toShard, type Shard } from 'quais';
import type { SkewState } from './client.js';

/**
 * Detect clock skew by comparing local time to a recent block timestamp.
 *
 * Compensation is the SDK's job (`ClientOptions.now`); deriving the offset is
 * ours, because the SDK correctly declined to make an extra RPC call on a
 * consumer's behalf (plan §2.1).
 *
 * Sign convention: **positive means the local clock is ahead of chain**, so the
 * adjusted now is `localNow - offset`.
 *
 * Quai is sharded and has no single chain head, so `getBlock` requires a shard.
 * We derive one from an address the caller already cares about, falling back to
 * Cyprus-1. Best-effort throughout: a failure here must never break the command
 * that asked, and `qv doctor` reports "not measured" rather than guessing.
 */
export async function detectSkew(
  qv: QuaiVaultClient,
  state: SkewState,
  anchorAddress?: string,
): Promise<SkewState> {
  if (state.detected) return state;
  try {
    const connection = (qv as unknown as { connection?: { provider?: unknown } }).connection;
    const provider = connection?.provider as
      | {
          getBlock?: (
            shard: Shard,
            tag: string,
          ) => Promise<{ timestamp?: unknown; woHeader?: { timestamp?: unknown } } | null>;
        }
      | undefined;
    if (!provider?.getBlock) return state;

    const shard = resolveShard(anchorAddress);
    if (!shard) return state;

    const block = await provider.getBlock(shard, 'latest');
    // A Quai block carries its timestamp on the work-object header, not at the
    // top level: `block.timestamp` is undefined here, unlike on an EVM chain.
    const ts = block?.woHeader?.timestamp ?? block?.timestamp;
    const blockSeconds =
      typeof ts === 'bigint'
        ? Number(ts)
        : typeof ts === 'number'
          ? ts
          : typeof ts === 'string'
            ? Number(ts)
            : Number.NaN;
    if (!Number.isFinite(blockSeconds) || blockSeconds <= 0) return state;

    state.offsetSeconds = Math.round(Date.now() / 1000 - blockSeconds);
    state.detected = true;
  } catch {
    // Undetected is an honest outcome. Never let this fail a caller.
  }
  return state;
}

function resolveShard(anchorAddress: string | undefined): Shard | null {
  try {
    if (anchorAddress) {
      const zone = getZoneForAddress(anchorAddress);
      if (zone) return toShard(zone);
    }
    // Cyprus-1: the zone the mainnet presets and most vaults use.
    return toShard('0x00');
  } catch {
    return null;
  }
}
