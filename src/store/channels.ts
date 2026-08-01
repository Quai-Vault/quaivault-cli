/**
 * The cross-vault channel budget (plan Phase 6).
 *
 * `watchVault` opens one WebSocket channel per vault, and Supabase Realtime
 * caps concurrent channels per client — while `inbox` and the TUI are
 * cross-vault by design. An owner of thirty vaults will silently stop
 * receiving events for some of them, and "silently" is the problem: the
 * symptom is a screen that looks live and is not.
 *
 * The policy is therefore: subscribe to the most relevant N, poll the tail,
 * and **state the cap in `qv doctor`** so degradation is visible rather than
 * mysterious.
 */

/**
 * Deliberately well under any plausible server cap. The cost of subscribing
 * to too few is a slower refresh on the tail, which is polled anyway; the
 * cost of subscribing to too many is events silently not arriving.
 */
export const CHANNEL_BUDGET = 10;

export interface ChannelPlan {
  /** Vaults that get a live subscription, in the order given. */
  subscribed: string[];
  /** Vaults that fall outside the budget and are polled instead. */
  polled: string[];
  budget: number;
  /** True when the tail exists — the only case worth reporting. */
  degraded: boolean;
}

/**
 * Split vaults into subscribed and polled.
 *
 * Order is the caller's relevance order — most recently active first — so the
 * vaults a user is actually watching are the ones that stay live.
 */
export function planChannels(vaults: readonly string[], budget = CHANNEL_BUDGET): ChannelPlan {
  const unique = [...new Set(vaults.map((v) => v.toLowerCase()))];
  const subscribed = unique.slice(0, Math.max(0, budget));
  const polled = unique.slice(subscribed.length);
  return { subscribed, polled, budget, degraded: polled.length > 0 };
}

/** One line for `qv doctor`, so the cap is never a mystery. */
export function describeChannels(plan: ChannelPlan): string {
  if (!plan.degraded) {
    return `${plan.subscribed.length} of ${plan.budget} realtime channels in use`;
  }
  return (
    `${plan.subscribed.length} of ${plan.budget} realtime channels in use; ` +
    `${plan.polled.length} vault${plan.polled.length === 1 ? '' : 's'} polled instead of watched`
  );
}
