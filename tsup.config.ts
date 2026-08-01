import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  version: string;
  dependencies: Record<string, string>;
};

export default defineConfig({
  entry: { qv: 'src/bin/qv.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  dts: false,
  // Every runtime dependency stays external. Bundling `quais` would defeat the
  // peer-dependency dedupe the SDK relies on (plan §5.4), and bundling the SDK
  // would silently freeze a copy that no longer matches the installed one.
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
