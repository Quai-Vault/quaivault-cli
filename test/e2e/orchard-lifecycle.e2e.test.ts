import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Tier 5 against the Orchard fixture vaults (plan §6, Phase 2).
 *
 * Phase 2's exit criterion is a "fixture vault [that] holds a proposal in
 * every lifecycle state, recreatable by script". This is the half that reads
 * those states back through the built binary and checks the CLI reports each
 * one correctly — which is the part a unit test with a fake client cannot do,
 * because the fake is written by the same person as the assertion.
 *
 * Skips entirely when `test/e2e/fixture-vaults.json` is absent, so the suite
 * stays runnable for anyone without a funded Orchard key. Create it with:
 *
 *   QUAIVAULT_PRIVATE_KEY_FILE=… node scripts/fixture-vault.mjs
 *
 * **Read-only.** Nothing here signs, approves or executes: the fixture states
 * are the point, and a test that consumed them would leave the next run with
 * nothing to assert against.
 */

interface Fixture {
  network: string;
  deployer: string;
  vaults: { held: string; solo: string };
  states: Record<string, string>;
}

const FIXTURE_PATH = 'test/e2e/fixture-vaults.json';
const BIN = join(process.cwd(), 'dist', 'qv.js');
const available = existsSync(FIXTURE_PATH) && existsSync(BIN);
const fixture: Fixture | null = available
  ? (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture)
  : null;

let home: string;

async function qv(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1' };
  for (const key of Object.keys(env)) if (key.startsWith('QUAIVAULT_')) delete env[key];
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

beforeAll(() => {
  if (!available) return;
  // Isolated HOME, as in the mainnet e2e: a suite that talks to a live chain
  // must not also be able to read the operator's keystore.
  home = mkdtempSync(join(tmpdir(), 'qv-orchard-'));
  mkdirSync(join(home, '.quaivault'), { recursive: true });
  writeFileSync(
    join(home, '.quaivault', 'config.toml'),
    `default_profile = "default"\n\n[profiles.default]\nnetwork = "testnet"\naddress = "${fixture!.deployer}"\n`,
  );
});

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe.skipIf(!available)('Orchard fixture vaults', () => {
  it('reads both vaults with no key configured', async () => {
    for (const [name, address] of Object.entries(fixture!.vaults)) {
      const { stdout, code } = await qv(['vault', 'show', address, '--json']);
      expect(code, `${name} ${address}`).toBe(0);
      const body = JSON.parse(stdout) as { ok: boolean; data: { owners: string[] } };
      expect(body.ok).toBe(true);
      expect(body.data.owners).toContain(fixture!.deployer);
    }
  });

  it('reports the held vault as needing a quorum the deployer cannot reach', async () => {
    const { stdout } = await qv(['vault', 'show', fixture!.vaults.held, '--json']);
    const body = JSON.parse(stdout) as { data: { threshold: number; owners: string[] } };
    expect(body.data.threshold).toBe(2);
    expect(body.data.owners).toHaveLength(2);
  });

  it('reports the solo vault as single-signature', async () => {
    const { stdout } = await qv(['vault', 'show', fixture!.vaults.solo, '--json']);
    const body = JSON.parse(stdout) as { data: { threshold: number; owners: string[] } };
    expect(body.data.threshold).toBe(1);
    expect(body.data.owners).toHaveLength(1);
  });

  /**
   * The lifecycle states. `expired` is excluded from the strict mapping
   * because it only becomes expired once someone calls `qv tx expire` past
   * the expiry, which the script leaves as a manual step.
   */
  const EXPECTED: Record<string, string[]> = {
    pending: ['pending'],
    cancelled: ['cancelled'],
    ready: ['ready'],
    timelocked: ['timelocked'],
    executed: ['executed'],
    failed: ['failed'],
    expired: ['pending', 'expired'],
  };

  it('renders every recorded lifecycle state with the status the CLI claims', async () => {
    const seen: Record<string, string> = {};
    for (const [state, hash] of Object.entries(fixture!.states)) {
      const vault = ['pending', 'cancelled', 'expired'].includes(state)
        ? fixture!.vaults.held
        : fixture!.vaults.solo;
      const { stdout, code } = await qv(['tx', 'show', vault, hash, '--json']);
      expect(code, `${state} ${hash}`).toBe(0);
      const body = JSON.parse(stdout) as { data: { status: string } };
      seen[state] = body.data.status;
    }
    // Report the whole map on failure rather than dying at the first mismatch:
    // knowing which states are wrong is the useful signal.
    const wrong = Object.entries(seen).filter(
      ([state, status]) => !(EXPECTED[state] ?? []).includes(status),
    );
    expect(wrong, `observed: ${JSON.stringify(seen)}`).toEqual([]);
  });

  it('serializes every value as a decimal string over live fixture data', async () => {
    const hash = fixture!.states.ready ?? Object.values(fixture!.states)[0]!;
    const { stdout } = await qv(['tx', 'show', fixture!.vaults.solo, hash, '--json']);
    const body = JSON.parse(stdout) as { data: Record<string, unknown> };
    expect(typeof body.data.value).toBe('string');
    expect(body.data.value as string).toMatch(/^\d+$/);
  });

  it('emits a verify block an agent can bind an --expect-* flag to', async () => {
    const hash = fixture!.states.ready ?? Object.values(fixture!.states)[0]!;
    const { stdout } = await qv(['tx', 'show', fixture!.vaults.solo, hash, '--json']);
    const body = JSON.parse(stdout) as {
      data: { verify: { to: string; value: string; dataHash: string; abiSource: string } };
    };
    expect(body.data.verify.dataHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.data.verify.value).toMatch(/^\d+$/);
    expect(body.data.verify.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('fails closed when an --expect-* assertion does not match', async () => {
    // §3.4: any mismatch against re-read chain state exits 3 with nothing
    // signed. `--dry-run` keeps this read-only.
    const hash = fixture!.states.ready ?? Object.values(fixture!.states)[0]!;
    const { code, stdout, stderr } = await qv([
      'tx',
      'approve',
      fixture!.vaults.solo,
      hash,
      '--expect-to',
      '0x0000000000000000000000000000000000000000',
      '--dry-run',
      '--json',
    ]);
    expect(code).not.toBe(0);
    expect(`${stdout}${stderr}`).toMatch(/expect|match/i);
  });
});
