import { describe, expect, it } from 'vitest';
import type { AbiSource, ExecuteOutcome } from '@quaivault/sdk';
import { ExitCode, exitCodeForErrorCode } from '../../src/cli/exit.js';
import { normalizeError, remedyFor } from '../../src/render/errors.js';
import { outcomeExit } from '../../src/commands/tx-write.js';
import { batchOf, renderDisclosure, txToJson, txUntrustedPointers } from '../../src/render/transaction.js';
import { createBufferIo } from '../../src/render/io.js';
import { jsonSafe } from '../../src/util/json.js';
import { createFakeContext } from '../fake-client.js';
import {
  ABI_SOURCE_FIXTURES,
  ALL_TRANSACTIONS,
  BATCH_FIXTURES,
  ERROR_FIXTURES,
  EXECUTE_FIXTURES,
} from '../fixtures/index.js';

// NO_COLOR and a fixed width, per §6: a snapshot that moves with the
// terminal is a snapshot of the terminal.
const io = () => createBufferIo(100);
const ctx = () => createFakeContext();

/** Walk a JSON value and collect every path whose value is a JS number. */
function numberPaths(value: unknown, path = ''): string[] {
  if (typeof value === 'number') return [path];
  if (Array.isArray(value)) return value.flatMap((v, i) => numberPaths(v, `${path}/${i}`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => numberPaths(v, `${path}/${k}`));
  }
  return [];
}

describe('every bigint serializes as a decimal string (Phase 1 exit criterion)', () => {
  /**
   * "`--json` emits `{"schema":1,…}` with every bigint a decimal string,
   * asserted over the fixture corpus."
   *
   * The failure this prevents is silent and total: `JSON.stringify` throws on
   * a raw bigint, and the obvious fix — `Number(value)` — loses precision
   * above 2^53. A wei amount is routinely above 2^53. `1.5 QUAI` is
   * 1500000000000000000, which is 1.5e18.
   */
  it.each(ALL_TRANSACTIONS.map((tx) => [tx.hash.slice(0, 10), tx] as const))(
    'round-trips %s through JSON without throwing',
    (_label, tx) => {
      const json = jsonSafe(txToJson(tx, 9_272_855, batchOf(tx, ctx())));
      expect(() => JSON.stringify(json)).not.toThrow();
    },
  );

  it('emits value and every sub-call value as a decimal string, never a number', () => {
    for (const tx of ALL_TRANSACTIONS) {
      const json = jsonSafe(txToJson(tx, 9_272_855, batchOf(tx, ctx()))) as Record<string, unknown>;
      expect(typeof json.value, tx.hash).toBe('string');
      expect(json.value as string, tx.hash).toMatch(/^\d+$/);
      const batch = json.batch as { calls?: { value: unknown }[] } | null;
      for (const call of batch?.calls ?? []) {
        expect(typeof call.value, tx.hash).toBe('string');
      }
    }
  });

  it('leaves numbers only where a number is genuinely correct', () => {
    // Block numbers, counts, thresholds and unix seconds are numbers on
    // purpose. Anything denominated in wei must not be — this pins the
    // distinction so a new bigint field cannot quietly arrive as a number.
    const NUMERIC_OK = new Set([
      '/dataLength',
      '/proposedAtBlock',
      '/chainHead',
      '/approvalCount',
      '/threshold',
      '/expiration',
      '/executionDelay',
      '/approvedAt',
      '/executableAfter',
      '/proposedAt',
      // Batch sub-call fields: a position and an operation byte, both of
      // which are counts rather than quantities.
      '/index',
      '/operation',
    ]);
    for (const tx of ALL_TRANSACTIONS) {
      const json = jsonSafe(txToJson(tx, 9_272_855, batchOf(tx, ctx())));
      for (const path of numberPaths(json)) {
        const normalized = path.replace(/\/batch\/calls\/\d+/, '');
        expect(NUMERIC_OK.has(normalized), `${tx.hash} ${path}`).toBe(true);
      }
    }
  });

  it('preserves a wei value that exceeds Number.MAX_SAFE_INTEGER exactly', () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    const json = jsonSafe(txToJson({ ...ABI_SOURCE_FIXTURES.builtin, value: huge })) as Record<
      string,
      unknown
    >;
    expect(json.value).toBe('123456789012345678901234567890');
    expect(BigInt(json.value as string)).toBe(huge);
  });
});

describe('all four abiSources render distinctly (Phase 3 exit criterion)', () => {
  const rendered = (source: AbiSource): string => {
    const b = io();
    renderDisclosure(ABI_SOURCE_FIXTURES[source], b, ctx());
    return b.stdout.join('\n');
  };

  it('gives every provenance its own output', () => {
    const outputs = (['builtin', 'heuristic', 'supplied', 'none'] as const).map(rendered);
    expect(new Set(outputs).size).toBe(4);
  });

  it('renders heuristic visibly distinctly from builtin', () => {
    // The SDK deliberately does not hedge a heuristic summary, so this is the
    // only place a reviewer learns the decode was a four-byte guess.
    expect(rendered('heuristic')).toMatch(/guess/i);
    expect(rendered('builtin')).not.toMatch(/guess/i);
  });

  it('shows the full raw calldata when the ABI is unknown', () => {
    const text = rendered('none');
    expect(text).toContain('unknown ABI');
    expect(text).toContain('11'.repeat(32));
    expect(text).toContain('22'.repeat(32));
    expect(text).not.toContain('…');
  });

  it.each(['builtin', 'heuristic', 'supplied', 'none'] as const)(
    'snapshots the %s disclosure',
    (source) => {
      expect(rendered(source)).toMatchSnapshot();
    },
  );
});

describe('batch disclosures snapshot', () => {
  it.each(Object.keys(BATCH_FIXTURES) as (keyof typeof BATCH_FIXTURES)[])(
    'snapshots the %s batch',
    (name) => {
      const b = io();
      renderDisclosure(BATCH_FIXTURES[name], b, ctx());
      expect(b.stdout.join('\n')).toMatchSnapshot();
    },
  );

  it('lists every sub-call summary as untrusted', () => {
    // §8 R7: a batch is the easiest place to hide injected prose, because the
    // outer summary is only ever "Batched call: N sub-transactions".
    const tx = BATCH_FIXTURES.mixed;
    const pointers = txUntrustedPointers('', batchOf(tx, ctx()));
    expect(pointers).toContain('/summary');
    expect(pointers).toContain('/batch/calls/0/summary');
    expect(pointers).toContain('/batch/calls/1/summary');
  });
});

describe('all four ExecuteOutcomes map to distinct exit codes (Phase 3 exit criterion)', () => {
  it.each(Object.keys(EXECUTE_FIXTURES) as ExecuteOutcome[])(
    '%s maps to its documented exit code',
    (outcome) => {
      const expected = {
        executed: ExitCode.Ok,
        failed: ExitCode.Failure,
        timelock_started: ExitCode.NotExecuted,
        approved_only: ExitCode.NotExecuted,
      }[outcome];
      expect(outcomeExit(EXECUTE_FIXTURES[outcome].outcome)).toBe(expected);
    },
  );

  it('never lets a reverted vault call exit 0', () => {
    // Appendix A: a UI checked only the outer receipt status and rendered a
    // green check for an inner-call revert. The chain transaction succeeded;
    // the thing the user asked for did not.
    expect(outcomeExit(EXECUTE_FIXTURES.failed.outcome)).not.toBe(ExitCode.Ok);
  });

  it('separates not-executed from both success and failure', () => {
    // `qv tx execute && deploy.sh` must not proceed on a started timelock.
    for (const outcome of ['timelock_started', 'approved_only'] as const) {
      const code = outcomeExit(EXECUTE_FIXTURES[outcome].outcome);
      expect(code).not.toBe(ExitCode.Ok);
      expect(code).not.toBe(ExitCode.Failure);
    }
  });

  it('serializes gasUsed as a decimal string', () => {
    for (const result of Object.values(EXECUTE_FIXTURES)) {
      const json = jsonSafe({ gasUsed: result.gasUsed }) as Record<string, unknown>;
      expect(typeof json.gasUsed).toBe('string');
    }
  });
});

describe('every SDK error class is handled (plan §6 Tier 3)', () => {
  it.each(Object.keys(ERROR_FIXTURES))('normalizes %s without leaking internals', (name) => {
    const rendered = normalizeError(ERROR_FIXTURES[name]);
    expect(rendered.code, name).toBeTruthy();
    expect(rendered.message, name).toBeTruthy();
    // A quais provider error carries `.info.payload` — the full JSON-RPC
    // body, sometimes including the endpoint. Nothing structural may survive.
    expect(JSON.stringify(rendered)).not.toMatch(/payload|stack|cause/i);
  });

  it.each(Object.keys(ERROR_FIXTURES))('maps %s to a non-zero exit code', (name) => {
    const code = exitCodeForErrorCode(normalizeError(ERROR_FIXTURES[name]).code);
    expect(code, name).not.toBe(ExitCode.Ok);
  });

  it('maps an aborted read to 130, not to a generic failure', () => {
    expect(exitCodeForErrorCode(normalizeError(ERROR_FIXTURES.AbortError).code)).toBe(
      ExitCode.Interrupted,
    );
  });

  it('maps policy and precondition classes to exit 3', () => {
    for (const name of ['PreconditionError', 'NoSignerError', 'NoIndexerError', 'StaleProposalError']) {
      expect(exitCodeForErrorCode(normalizeError(ERROR_FIXTURES[name]).code), name).toBe(
        ExitCode.Precondition,
      );
    }
  });

  it('gives every code either a remediation command or a deliberate absence', () => {
    for (const name of Object.keys(ERROR_FIXTURES)) {
      const code = normalizeError(ERROR_FIXTURES[name]).code;
      // remedyFor returns undefined both for "no command" and for unknown
      // codes; the registry test in contract.test.ts is what distinguishes
      // them. Here we only assert it never throws on a real error class.
      expect(() => remedyFor(code)).not.toThrow();
    }
  });

  it.each(Object.keys(ERROR_FIXTURES))('snapshots the rendered %s', (name) => {
    expect(normalizeError(ERROR_FIXTURES[name])).toMatchSnapshot();
  });
});
