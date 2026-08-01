import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Ink must stay off the one-shot path (plan §4.4).
 *
 * `qv tui` reaches Ink through a dynamic import and tsup runs with
 * `splitting: true`, so React lands in its own chunk. A static import — or
 * splitting being turned off — would inline that module and hoist
 * `import 'ink'` into the main bundle, and then **every** `qv inbox` would
 * load React. Measured at ~420 ms, against a ~373 ms total startup: it would
 * roughly double the cost of every invocation, for a UI the caller never
 * draws. §4.4 calls that "a real tax on an agent invoking us hundreds of
 * times".
 *
 * The property is invisible in source and only observable in `dist/`, which
 * is exactly the kind of thing that regresses silently. CI builds before
 * running the suite; locally these skip if `dist/` is absent.
 */

const DIST = 'dist';
const MAIN = join(DIST, 'qv.js');
const built = existsSync(MAIN);

describe.skipIf(!built)('the built bundle', () => {
  const main = built ? readFileSync(MAIN, 'utf8') : '';

  /** Static `import … from "x"` — hoisted, always loaded, top of the file. */
  const staticImports = (text: string): string[] =>
    [...text.matchAll(/^import[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1]!);

  /** Dynamic `import("x")` — loaded only when the call runs. */
  const dynamicImports = (text: string): string[] =>
    [...text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]!);

  it('never statically imports ink or react', () => {
    // The distinction is the whole point. A static import is hoisted and
    // executed on load; a dynamic one is not. Asserting merely that the
    // string "ink" is absent would be wrong — the dynamic specifier is a
    // string literal in the bundle and *must* be.
    const statics = staticImports(main);
    expect(statics).not.toContain('ink');
    expect(statics).not.toContain('react');
    expect(statics).not.toContain('react/jsx-runtime');
  });

  it('reaches ink through a dynamic import instead', () => {
    // The other half: if the TUI were deleted or the import inlined, the
    // assertion above would pass vacuously.
    const dynamics = dynamicImports(main);
    expect(dynamics).toContain('ink');
    expect(dynamics).toContain('react');
  });

  it('emits a separate chunk that does import them', () => {
    // The other half: if splitting silently stopped producing a chunk, the
    // assertions above could pass because the TUI had been dropped entirely.
    const chunks = readdirSync(DIST).filter((f) => f.endsWith('.js') && f !== 'qv.js');
    expect(chunks.length, 'no split chunk was emitted').toBeGreaterThan(0);
    const text = chunks.map((f) => readFileSync(join(DIST, f), 'utf8')).join('\n');
    expect(text).toMatch(/from\s*["']ink["']/);
    expect(text).toMatch(/from\s*["']react\/jsx-runtime["']/);
  });

  it('keeps every runtime dependency external rather than vendored', () => {
    // Bundling quais would defeat the peer-dependency dedupe the SDK relies
    // on (§5.4), and bundling the SDK would freeze a copy that no longer
    // matches the installed one.
    expect(main).toMatch(/from\s*["']@quaivault\/sdk["']/);
    expect(main).toMatch(/from\s*["']quais["']/);
  });

  it('starts with a shebang so the binary is executable', () => {
    expect(main.startsWith('#!/usr/bin/env node')).toBe(true);
  });
});
