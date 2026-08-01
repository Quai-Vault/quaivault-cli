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
  // Code splitting is what keeps ink off the one-shot path. `qv tui` reaches
  // its ink app through a dynamic import; without splitting, esbuild inlines
  // that module and hoists its `import 'ink'` to the top of the bundle, so
  // every `qv inbox` would pay ~420ms to load React for a UI it never draws.
  // There is a startup test asserting this stays true.
  splitting: true,
  sourcemap: true,
  dts: false,
  // Every runtime dependency stays external. Bundling `quais` would defeat the
  // peer-dependency dedupe the SDK relies on (plan §5.4), and bundling the SDK
  // would silently freeze a copy that no longer matches the installed one.
  external: Object.keys(pkg.dependencies),
  banner: { js: '#!/usr/bin/env node' },
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
