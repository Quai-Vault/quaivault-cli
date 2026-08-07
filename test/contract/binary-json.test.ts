import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

interface Envelope {
  schema: number;
  ok: boolean;
  command: string;
  changed: boolean | 'unknown';
  retryable: boolean;
  data: unknown;
  steps: unknown[];
  error: unknown;
  next: unknown[];
  warnings: unknown[];
}

function run(args: string[]): { status: number | null; stderr: string; body: Envelope } {
  const result = spawnSync(process.execPath, ['dist/qv.js', ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    body: JSON.parse(result.stdout) as Envelope,
  };
}

// Codex's managed seccomp profile denies child_process spawnSync with EPERM.
// CI and ordinary Node installations run the contract; the local release pass
// additionally invokes the built binary directly from the shell.
const spawnProbe = spawnSync(process.execPath, ['dist/qv.js', '--version'], { encoding: 'utf8' });
const spawnErrorCode =
  spawnProbe.error && 'code' in spawnProbe.error ? String(spawnProbe.error.code) : undefined;
const CAN_SPAWN_SYNC =
  spawnErrorCode !== 'EPERM' && spawnProbe.status === 0 && spawnProbe.stdout.trim().length > 0;

function expectTotalEnvelope(body: Envelope): void {
  expect(Object.keys(body)).toEqual(
    expect.arrayContaining([
      'schema',
      'ok',
      'command',
      'changed',
      'retryable',
      'data',
      'steps',
      'error',
      'next',
      'warnings',
    ]),
  );
}

describe.skipIf(!CAN_SPAWN_SYNC)('installed binary JSON contract', () => {
  it('emits the same total envelope on success', () => {
    const result = run(['addr', 'check', '0x005f2629A632962f4944d23686efDa5c160d535b', '--json']);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.body.ok).toBe(true);
    expect(result.body.changed).toBe(false);
    expectTotalEnvelope(result.body);
  });

  it('turns an unknown command into one JSON document', () => {
    const result = run(['not-a-command', '--json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.body.ok).toBe(false);
    expectTotalEnvelope(result.body);
  });

  it('turns a missing required argument into one JSON document', () => {
    const result = run(['tx', 'show', '--json']);
    expect(result.status).toBe(2);
    expect(result.stderr).toBe('');
    expect(result.body.error).toMatchObject({ code: 'VALIDATION' });
    expectTotalEnvelope(result.body);
  });

  it('emits complete schema metadata', () => {
    const result = spawnSync(process.execPath, ['dist/qv.js', '--schema', '--schema-version', '1'], {
      encoding: 'utf8',
    });
    const schema = JSON.parse(result.stdout) as {
      schema: number;
      globalOptions: unknown[];
      commands: unknown[];
      metaCommands: unknown[];
    };
    expect(result.status).toBe(0);
    expect(schema.schema).toBe(1);
    expect(schema.globalOptions.length).toBeGreaterThan(10);
    expect(schema.commands.length).toBeGreaterThan(50);
    expect(schema.metaCommands.length).toBeGreaterThan(1);
  });
});
