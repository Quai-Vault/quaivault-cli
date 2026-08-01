import { describe, expect, it } from 'vitest';
import { jsonSafe, envelope, SCHEMA_VERSION } from '../../src/util/json.js';
import { ExitCode, exitCodeForErrorCode } from '../../src/cli/exit.js';
import { REGISTRY } from '../../src/cli/registry.js';
import { buildSchema } from '../../src/cli/schema.js';
import { commandId } from '../../src/cli/spec.js';
import { normalizeError, errorToJson, remedyFor } from '../../src/render/errors.js';

describe('json serialization', () => {
  it('renders every bigint as a decimal string, never a number', () => {
    // Number(v) silently loses precision above 2^53 — which is 0.009 QUAI.
    const big = 123_456_789_012_345_678_901_234_567_890n;
    const out = jsonSafe({ value: big, nested: [{ wei: 1n }] }) as Record<string, unknown>;
    expect(out.value).toBe('123456789012345678901234567890');
    expect(typeof out.value).toBe('string');
    expect((out.nested as { wei: string }[])[0]!.wei).toBe('1');
  });

  it('survives JSON.stringify, which throws on a raw bigint', () => {
    expect(() => JSON.stringify({ v: 1n })).toThrow(TypeError);
    expect(() => JSON.stringify(jsonSafe({ v: 1n }))).not.toThrow();
  });

  it('drops undefined rather than emitting null holes', () => {
    expect(jsonSafe({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('emits a stable envelope shape', () => {
    const parsed = JSON.parse(
      envelope({ schema: SCHEMA_VERSION, ok: true, command: 'tx show', data: { a: 1 } }),
    ) as Record<string, unknown>;
    expect(parsed.schema).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe('tx show');
  });
});

describe('exit codes', () => {
  it('maps not-executed outcomes away from success', () => {
    // `qv tx execute && deploy.sh` must not proceed on approved_only.
    expect(ExitCode.NotExecuted).toBe(4);
    expect(ExitCode.NotExecuted).not.toBe(ExitCode.Ok);
  });

  it('treats an unknown error code as a failure, never as success', () => {
    expect(exitCodeForErrorCode('SOMETHING_NEW')).toBe(ExitCode.Failure);
    expect(exitCodeForErrorCode(undefined)).toBe(ExitCode.Failure);
  });

  it('maps policy refusal to the precondition code', () => {
    expect(exitCodeForErrorCode('POLICY')).toBe(ExitCode.Precondition);
  });
});

describe('registry', () => {
  it('gives every command a unique path', () => {
    const ids = REGISTRY.map(commandId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every command an output schema — otherwise --schema drifts silently', () => {
    for (const spec of REGISTRY) {
      expect(spec.outputSchema, commandId(spec)).toBeTruthy();
      expect(typeof spec.outputSchema, commandId(spec)).toBe('object');
    }
  });

  it('gives every command a renderer and a json mapper', () => {
    for (const spec of REGISTRY) {
      expect(typeof spec.render, commandId(spec)).toBe('function');
      expect(typeof spec.toJson, commandId(spec)).toBe('function');
    }
  });

  it('implements either run or the plan/commit pair, never neither', () => {
    for (const spec of REGISTRY) {
      const isRead = typeof spec.run === 'function';
      const isWrite = typeof spec.plan === 'function' && typeof spec.commit === 'function';
      expect(isRead || isWrite, commandId(spec)).toBe(true);
    }
  });

  it('never exposes a flag that would put a secret in argv', () => {
    // /proc/*/cmdline is world-readable and rewriting argv does not change it.
    for (const spec of REGISTRY) {
      for (const opt of spec.options ?? []) {
        expect(opt.flags, commandId(spec)).not.toMatch(
          /--(private-key|password|mnemonic|secret)\b/,
        );
      }
    }
  });
});

describe('--schema', () => {
  const schema = buildSchema('1.2.3') as Record<string, any>;

  it('is valid JSON and round-trips', () => {
    expect(() => JSON.parse(JSON.stringify(schema))).not.toThrow();
  });

  it('covers every registered command', () => {
    expect(schema.commands).toHaveLength(REGISTRY.length);
    const ids = new Set(schema.commands.map((c: { command: string }) => c.command));
    for (const spec of REGISTRY) expect(ids.has(commandId(spec)), commandId(spec)).toBe(true);
  });

  it('publishes the exit-code and error-code taxonomy an agent needs', () => {
    expect(schema.exitCodes[String(ExitCode.NotExecuted)]).toBeTruthy();
    expect(schema.errorCodes.values).toContain('POLICY');
  });

  it('leaks no local configuration', () => {
    const text = JSON.stringify(schema);
    expect(text).not.toMatch(/\/home\//);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});

describe('error rendering', () => {
  it('reduces an unknown error to name and message only', () => {
    // A quais provider error carries .info.payload — the full JSON-RPC request
    // body, sometimes including the endpoint.
    const hostile = Object.assign(new Error('boom'), {
      info: { payload: { method: 'eth_call', apiKey: 'SECRET' } },
      cause: new Error('inner with SECRET'),
    });
    const rendered = normalizeError(hostile);
    const text = JSON.stringify(errorToJson(rendered));
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('eth_call');
  });

  it('maps codes to executable commands where one exists', () => {
    expect(remedyFor('NO_SIGNER')).toContain('qv key import');
    expect(remedyFor('VALIDATION')).toBeUndefined();
  });
});
