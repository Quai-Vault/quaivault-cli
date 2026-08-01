import { defineConfig } from 'vitest/config';

/**
 * Tier 5 — end-to-end (plan §6).
 *
 * "Excluded from `npm test`, never in the PR gate." A test that talks to a
 * live chain fails for reasons that have nothing to do with the diff in front
 * of you — a stalled indexer, a rate limit, a reorg — and a gate that goes red
 * without a cause in the changeset is a gate people learn to re-run until it
 * passes. That habit is what you actually lose.
 *
 * So this is a separate config with a separate command (`npm run test:e2e`),
 * and critically **no `test/setup.ts`**: the hermetic stubs that make Tier 1–3
 * fail loudly on network access are exactly what these tests need to not have.
 */
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // A cold RPC and an indexer round trip, plus the CLI's own startup, on
    // whatever the runner's network is.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Live-network tests share a rate limit; running them in parallel makes
    // them flake against each other rather than finding anything.
    fileParallelism: false,
    retry: 1,
  },
});
