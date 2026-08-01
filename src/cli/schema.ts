import { SCHEMA_VERSION, type JsonValue } from '../util/json.js';
import { ExitCode } from './exit.js';
import { REGISTRY } from './registry.js';
import { commandId } from './spec.js';

/**
 * `qv --schema` — machine-readable introspection (plan §4.2).
 *
 * A traversal of the registry, so it cannot drift from what actually exists;
 * a Phase 0 test asserts every descriptor carries an output schema.
 *
 * Deliberately static and content-free: it never enumerates configured
 * aliases, contacts, profiles or keystore paths.
 */
export function buildSchema(cliVersion: string): JsonValue {
  return {
    schema: SCHEMA_VERSION,
    cliVersion,
    envelope: {
      description:
        'Every --json invocation emits this envelope on stdout, success or failure. ' +
        'All bigint-valued fields are decimal strings in the smallest unit (wei), never numbers.',
      properties: {
        schema: 'integer, the version of this contract',
        ok: 'boolean',
        command: 'string, space-joined command path',
        changed: 'boolean | "unknown" — did this invocation cause a durable state change',
        retryable: 'boolean — is re-invoking safe and potentially useful',
        data: 'command-specific, see commands[].output',
        steps: 'array of {name,status,chainTxHash?,error?} for multi-write commands',
        error: '{code,message,remediation?,next?}',
        next: 'array of suggested follow-up invocations',
        untrusted: 'array of JSON Pointers into data carrying attacker-authored text',
        warnings: 'array of strings',
      },
    },
    exitCodes: {
      [ExitCode.Ok]: 'success',
      [ExitCode.Failure]:
        'operational failure, including execute outcome "failed" where the chain transaction succeeded but the vault call did not',
      [ExitCode.Usage]: 'usage error',
      [ExitCode.Precondition]: 'precondition not met, or refused by policy',
      [ExitCode.NotExecuted]: 'not executed and not an error: approved_only or timelock_started',
      [ExitCode.Declined]: 'user declined at a confirmation prompt',
      [ExitCode.Interrupted]: 'interrupted',
    },
    errorCodes: {
      description: 'Stable error codes. Line 1 of any rendered error is the code.',
      values: [
        'VALIDATION',
        'CONFIG',
        'PRECONDITION',
        'NO_SIGNER',
        'NO_INDEXER',
        'INDEXER_QUERY',
        'NOT_FOUND',
        'REVERT',
        'SALT_MINING',
        'STALE_PROPOSAL',
        'ABORTED',
        'POLICY',
        'DECLINED',
        'UNKNOWN',
      ],
    },
    notes: [
      'Proposal age is approximate, derived from a block delta. --json never emits a prose age: it emits proposedAtBlock, chainHead and proposedAtApproximate so the consumer does its own arithmetic.',
      'total on paged results is an estimate. hasMore is exact — branch on hasMore.',
      'Hash prefix matching is disabled under --json. Pass full 66-character hashes.',
    ],
    commands: REGISTRY.map((spec) => ({
      command: commandId(spec),
      describe: spec.describe,
      args: (spec.args ?? []).map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required === true,
        variadic: a.variadic === true,
      })),
      options: (spec.options ?? []).map((o) => ({
        flags: o.flags,
        description: o.description,
        choices: o.choices ? [...o.choices] : undefined,
        default: o.defaultValue ?? undefined,
      })),
      needs: {
        signer: spec.needs?.signer === true,
        identity: spec.needs?.identity === true,
        indexer: spec.needs?.indexer ?? null,
      },
      write: Boolean(spec.plan && spec.commit),
      output: spec.outputSchema,
    })),
  } as JsonValue;
}
