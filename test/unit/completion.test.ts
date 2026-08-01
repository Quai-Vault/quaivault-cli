import { describe, expect, it } from 'vitest';
import { completionEntries, completionScript, SHELLS } from '../../src/cli/completion.js';
import { REGISTRY } from '../../src/cli/registry.js';
import { commandId } from '../../src/cli/spec.js';

describe('completion is a registry traversal', () => {
  it('covers every registered command', () => {
    // Same property as `--schema`: one list, so a new command is completable
    // the moment it is registered and there is no second place to forget.
    const entries = new Set(completionEntries().map((e) => e.command));
    for (const spec of REGISTRY) expect(entries.has(commandId(spec)), commandId(spec)).toBe(true);
  });

  it.each(SHELLS)('emits a non-trivial script for %s', (shell) => {
    const script = completionScript(shell);
    expect(script.length).toBeGreaterThan(200);
    expect(script).toContain('qv');
  });

  it.each(SHELLS)('mentions the deepest commands for %s', (shell) => {
    const script = completionScript(shell);
    for (const word of ['approve', 'transfer', 'mine-salt', 'change-password']) {
      expect(script, `${shell} is missing ${word}`).toContain(word);
    }
  });
});

describe('completion leaks nothing about this machine', () => {
  /**
   * §4.2's rule for `--schema` — never enumerate configured aliases,
   * contacts or paths — binds harder here, because a completion script is
   * written to disk and sourced by every shell. Baking vault aliases into a
   * dotfile puts the names of the vaults someone holds into their backups and
   * dotfile repository permanently, to save a few keystrokes.
   */
  it.each(SHELLS)('contains no home directory or filesystem path in %s', (shell) => {
    const script = completionScript(shell);
    expect(script).not.toMatch(/\/home\//);
    expect(script).not.toMatch(/\/Users\//);
    expect(script).not.toMatch(/\.quaivault/);
  });

  it.each(SHELLS)('contains no address in %s', (shell) => {
    expect(completionScript(shell)).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it.each(SHELLS)('is byte-identical across runs, so it can be committed for %s', (shell) => {
    // A script that changed per invocation would churn in whatever dotfile
    // repository it lands in.
    expect(completionScript(shell)).toBe(completionScript(shell));
  });
});

describe('generated scripts are syntactically well-formed', () => {
  it('never emits a newline inside a description', () => {
    // A description with a newline would terminate the statement it sits in
    // and produce a script that fails to source.
    for (const entry of completionEntries()) {
      expect(entry.describe, entry.command).not.toMatch(/[\r\n]/);
    }
  });

  it('escapes single quotes and colons for zsh', () => {
    // zsh splits `value:description` on the first colon and terminates the
    // description on a bare quote — both appear in ordinary English.
    const script = completionScript('zsh');
    for (const line of script.split('\n')) {
      const m = /^\s+'([^']*)'$/.exec(line);
      if (!m) continue;
      const body = m[1]!;
      // Every colon inside a _describe entry must be either the separator or
      // escaped. Count unescaped ones: exactly one separator is allowed.
      const unescaped = body.split('').filter((c, i) => c === ':' && body[i - 1] !== '\\');
      expect(unescaped.length, line).toBeLessThanOrEqual(1);
    }
  });

  it('quotes every fish description', () => {
    for (const line of completionScript('fish').split('\n')) {
      if (!line.includes(' -d ')) continue;
      expect(line, line).toMatch(/ -d '.*'$/);
    }
  });

  it('balances braces in the bash script', () => {
    const script = completionScript('bash');
    const open = (script.match(/\{/g) ?? []).length;
    const close = (script.match(/\}/g) ?? []).length;
    expect(open).toBe(close);
  });
});
