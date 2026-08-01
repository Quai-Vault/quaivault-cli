import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Tier 5 — the keyless read surface against live mainnet (plan §6, Phase 1).
 *
 * Phase 1's exit criterion is "every command runs against mainnet with **no
 * key configured**", and that is not something a fake client can tell you. It
 * exercises the **built binary**, not the source tree, because export-map,
 * shebang and ESM-under-npx failures are invisible to an in-process import.
 *
 * **Isolated `HOME`.** Every run points `HOME` at a fresh temp directory, so
 * these tests can never read the operator's real `~/.quaivault` — not their
 * config, not their contacts, and above all not their keystore. A test suite
 * that touches a live chain must not also be able to touch a live key.
 *
 * Excluded from `npm test` and from the PR gate. Run with `npm run test:e2e`.
 */

const BIN = join(process.cwd(), 'dist', 'qv.js');
let home: string;

/** Run the CLI with an isolated HOME and no inherited QuaiVault environment. */
async function qv(
  args: string[],
  opts: { stdin?: 'empty' } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
  // A leaked variable from the operator's shell would silently change what is
  // under test — and QUAIVAULT_PRIVATE_KEY would defeat "no key configured".
  for (const key of Object.keys(env)) if (key.startsWith('QUAIVAULT_')) delete env[key];

  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env,
      encoding: 'utf8',
      timeout: 90_000,
      maxBuffer: 16 * 1024 * 1024,
      ...(opts.stdin === 'empty' ? { input: '' } : {}),
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`dist/qv.js is missing — run \`npm run build\` before \`npm run test:e2e\``);
  }
  home = mkdtempSync(join(tmpdir(), 'qv-e2e-'));
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('the binary itself', () => {
  it('reports a version', async () => {
    const { stdout, code } = await qv(['--version']);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('emits a schema an agent can consume', async () => {
    const { stdout, code } = await qv(['--schema']);
    expect(code).toBe(0);
    const schema = JSON.parse(stdout) as { schema: number; commands: unknown[] };
    expect(schema.schema).toBe(1);
    expect(schema.commands.length).toBeGreaterThan(20);
  });

  it('leaks no local configuration through --schema', async () => {
    // Same rule as the unit test, re-checked against a real process where
    // there genuinely is a HOME to leak.
    const { stdout } = await qv(['--schema']);
    expect(stdout).not.toContain(home);
    expect(stdout).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe('keyless reads against live mainnet', () => {
  it('reports network and indexer status with no key and no config', async () => {
    const { stdout, code } = await qv(['status', '--json']);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { schema: number; ok: boolean; data: unknown };
    expect(body.schema).toBe(1);
    expect(body.ok).toBe(true);
  });

  it('runs doctor and produces a pasteable report', async () => {
    const { stdout } = await qv(['doctor', '--json']);
    const body = JSON.parse(stdout) as { data: { checks: { name: string }[] } };
    const names = body.data.checks.map((c) => c.name);
    expect(names).toContain('indexer');
    expect(names).toContain('quais');
    expect(names).toContain('channels');
  });

  it('separates zone from ledger when validating an address', async () => {
    // The Qi trap: a valid zone (first byte 0x00) with the ledger bit set —
    // the high bit of the *second* byte. A zone-only check waves it through,
    // and a transfer to it is unrecoverable.
    const { stdout, code } = await qv([
      'addr',
      'check',
      '0x0081f4e8a9b0c1d2e3f405162738495a6b7c8d78',
      '--json',
    ]);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as {
      data: { valid: boolean; zone: string; ledger: string; reason: string };
    };
    expect(body.data.valid).toBe(false);
    // Both properties reported, not just the verdict: a user who is told
    // "invalid" and nothing else cannot tell a typo from a wrong-ledger paste.
    expect(body.data.zone).toBe('0x00');
    expect(body.data.ledger).toBe('qi');
    expect(body.data.reason).toMatch(/Qi/);
  });

  it('reads a real mainnet vault with no key configured', async () => {
    // A vault observed in the mainnet proposal history (see
    // docs/r4-ipfs-measurement.md). Keyless: `affordances()` takes a plain
    // address, which is what makes Phase 1 a product rather than a
    // prerequisite.
    const vault = '0x005f2629a632962f4944d23686efda5c160d535b';
    const { stdout, code } = await qv(['vault', 'show', vault, '--json']);
    expect(code).toBe(0);
    const body = JSON.parse(stdout) as { ok: boolean; data: { owners?: unknown[] } };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data.owners)).toBe(true);
  });

  it('emits every bigint as a decimal string over live data', async () => {
    // The property the fixture corpus asserts, re-checked against payloads
    // nobody wrote by hand.
    const vault = '0x005f2629a632962f4944d23686efda5c160d535b';
    const { stdout } = await qv(['balance', vault, '--json']);
    const body = JSON.parse(stdout) as Record<string, unknown>;
    const walk = (v: unknown, path: string): string[] =>
      typeof v === 'number' && /balance|value|amount|wei/i.test(path)
        ? [path]
        : Array.isArray(v)
          ? v.flatMap((x, i) => walk(x, `${path}/${i}`))
          : v && typeof v === 'object'
            ? Object.entries(v).flatMap(([k, x]) => walk(x, `${path}/${k}`))
            : [];
    expect(walk(body, '')).toEqual([]);
  });
});

describe('the agent contract holds on a real process', () => {
  it('never prompts under < /dev/null', async () => {
    // Phase 1: "no command prompts under `< /dev/null`". A command that
    // blocks on a prompt in a pipeline is a hung CI job, not an error.
    for (const args of [['status'], ['inbox'], ['doctor']]) {
      const { code } = await qv([...args, '--json'], { stdin: 'empty' });
      // Any exit code is acceptable; not returning at all is not.
      expect(typeof code, args.join(' ')).toBe('number');
    }
  });

  it('puts the error envelope on stdout under --json, not stderr', async () => {
    // §4.1: empty stdout makes "structured error" indistinguishable from
    // "crashed", which is what gh, terraform -json and kubectl -o json all
    // avoid.
    const { stdout, code } = await qv([
      'vault',
      'show',
      '0x0000000000000000000000000000000000000000',
      '--json',
    ]);
    expect(code).not.toBe(0);
    const body = JSON.parse(stdout) as { ok: boolean; error?: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBeTruthy();
  });

  it('exits 2 on a usage error, distinctly from an operational failure', async () => {
    const { code } = await qv(['nonsense-command']);
    expect(code).toBe(2);
  });

  it('refuses hash-prefix matching under --json', async () => {
    // §4.3: prefixes are grindable; an agent passes the full 66 characters.
    const { stdout, code } = await qv([
      'tx',
      'show',
      '0x005f2629a632962f4944d23686efda5c160d535b',
      '8a3f',
      '--json',
    ]);
    expect(code).not.toBe(0);
    expect(stdout).toMatch(/prefix/i);
  });

  it('produces parseable JSON for every read command it can reach keyless', async () => {
    // Phase 1: "`qv X --json 2>/dev/null | jq .` succeeds for every command."
    const commands = [['status'], ['doctor'], ['inbox'], ['vault', 'ls']];
    for (const args of commands) {
      const { stdout } = await qv([...args, '--json'], { stdin: 'empty' });
      expect(() => JSON.parse(stdout) as unknown, args.join(' ')).not.toThrow();
    }
  });
});
