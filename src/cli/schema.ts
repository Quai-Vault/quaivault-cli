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
export function buildSchema(cliVersion: string, requestedVersion = SCHEMA_VERSION): JsonValue {
  if (requestedVersion !== SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version ${requestedVersion}; supported: ${SCHEMA_VERSION}.`);
  }
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
      exitAndRetry: {
        VALIDATION: { exitCode: ExitCode.Usage, retryable: false },
        CONFIG: { exitCode: ExitCode.Usage, retryable: false },
        PRECONDITION: { exitCode: ExitCode.Precondition, retryable: false },
        POLICY: { exitCode: ExitCode.Precondition, retryable: false },
        NO_SIGNER: { exitCode: ExitCode.Precondition, retryable: false },
        NO_INDEXER: { exitCode: ExitCode.Precondition, retryable: true },
        INDEXER_QUERY: { exitCode: ExitCode.Failure, retryable: true },
        ABORTED: { exitCode: ExitCode.Interrupted, retryable: true },
        UNKNOWN: { exitCode: ExitCode.Failure, retryable: false },
      },
    },
    globalOptions: [
      { flags: '--json', description: 'one JSON envelope; implies --no-input, not --yes' },
      { flags: '-y, --yes', description: 'authorize a non-interactive write subject to policy' },
      { flags: '--no-input', description: 'never prompt' },
      { flags: '-q, --quiet', description: 'suppress human hints' },
      { flags: '--debug', description: 'include diagnostic stacks on human errors' },
      { flags: '--wide', description: 'disable human-output truncation' },
      { flags: '--color <mode>', choices: ['auto', 'always', 'never'] },
      { flags: '-p, --profile <name>' },
      { flags: '--vault <alias|address>' },
      { flags: '--as <address>' },
      { flags: '--dry-run', description: 'return a machine-safe preview without signing' },
      { flags: '--i-understand-unverified', description: 'explicitly acknowledge unverified calldata' },
    ],
    metaCommands: [
      { command: '--schema', usage: 'qv --schema [--schema-version 1]' },
      { command: 'completion', usage: 'qv completion <bash|zsh|fish>' },
    ],
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
      input: {
        requiredArguments: (spec.args ?? []).filter((arg) => arg.required).map((arg) => arg.name),
        positionalArguments: (spec.args ?? []).map((arg) => arg.name),
        optionFlags: (spec.options ?? []).map((option) => option.flags),
      },
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
