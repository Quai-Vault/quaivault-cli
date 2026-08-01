import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    exclude: ['test/e2e/**', '**/node_modules/**', '**/dist/**'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    restoreMocks: true,
    // Tier 1-3 must run with no network at all. `test/setup.ts` enforces it by
    // replacing fetch/net/WebSocket with throwing stubs (plan §6).
    testTimeout: 10_000,
  },
  define: { __CLI_VERSION__: JSON.stringify('0.0.0-test') },
});
