import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { AbiSource } from '@quaivault/sdk';
import { configHome, writeFileAtomic } from './config.js';

/**
 * The agent authority boundary (plan §3.4).
 *
 * Flags are not a control against the caller: an agent emits a second
 * confirmation flag as readily as the first. So the bound lives in a file at a
 * fixed path with **no flag to relocate it and no environment override**.
 */
export interface Policy {
  maxValuePerApprovalWei?: bigint;
  maxApprovalsPerHour?: number;
  /** Empty means any. */
  allowTo: string[];
  denyKinds: string[];
  denyDelegatecall: boolean;
  /** Which decode provenances may be signed non-interactively. */
  requireAbiSource: AbiSource[];
}

export const POLICY_FILENAME = 'policy.toml';

export function policyPath(): string {
  return join(configHome(), POLICY_FILENAME);
}

export class PolicyViolation extends Error {
  readonly code = 'POLICY';
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyViolation';
  }
}

/** Absent policy is represented as `null`, never as an empty permissive one. */
export function loadPolicy(path = policyPath()): Policy | null {
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, 'utf8'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw new Error(`Could not read policy at ${path}: ${e.message}`);
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const abiSources = strList(o.require_abi_source).filter((s): s is AbiSource =>
    ['builtin', 'heuristic', 'supplied', 'none'].includes(s),
  );
  return {
    maxValuePerApprovalWei:
      typeof o.max_value_per_approval_wei === 'string'
        ? BigInt(o.max_value_per_approval_wei)
        : undefined,
    maxApprovalsPerHour:
      typeof o.max_approvals_per_hour === 'number' ? o.max_approvals_per_hour : undefined,
    allowTo: strList(o.allow_to).map((a) => a.toLowerCase()),
    denyKinds: strList(o.deny_kinds),
    denyDelegatecall: o.deny_delegatecall !== false,
    requireAbiSource: abiSources.length ? abiSources : ['builtin'],
  };
}

export const STARTER_POLICY = `# QuaiVault CLI policy
#
# This file bounds what may be signed NON-INTERACTIVELY (agents, CI, --yes).
# An attended human at a TTY is not restricted by it.
#
# It is loaded from a fixed path. There is deliberately no flag to point
# elsewhere and no environment override — a bound the caller can move is not a
# bound. Violations exit 3 and name the rule.

# Largest value a single approval may move, in wei. Remove for no limit.
max_value_per_approval_wei = "1000000000000000000"

# Rate limit on non-interactive approvals.
max_approvals_per_hour = 5

# Recipients that may be approved non-interactively. Empty list = any address.
allow_to = []

# Transaction kinds refused outright. These change who controls the vault.
deny_kinds = ["wallet_admin", "module_config", "recovery_setup"]

# DelegateCall lets the target rewrite vault storage. Keep this true.
deny_delegatecall = true

# Which decode provenances are trustworthy enough to sign unattended.
# "builtin" = an ABI the SDK vouches for. Anything else is a guess or a claim.
require_abi_source = ["builtin"]
`;

export function writeStarterPolicy(path = policyPath()): string {
  writeFileAtomic(path, STARTER_POLICY, 0o600);
  return path;
}

/** The fields `qv policy set` accepts, in the order they are displayed. */
export const POLICY_FIELDS = [
  'max_value_per_approval_wei',
  'max_approvals_per_hour',
  'allow_to',
  'deny_kinds',
  'deny_delegatecall',
  'require_abi_source',
] as const;

export type PolicyField = (typeof POLICY_FIELDS)[number];

export const ABI_SOURCES: readonly AbiSource[] = ['builtin', 'heuristic', 'supplied', 'none'];

/** How each field renders, for `qv policy show` and the TUI. */
export function policyValue(policy: Policy, field: PolicyField): string {
  switch (field) {
    case 'max_value_per_approval_wei':
      return policy.maxValuePerApprovalWei?.toString(10) ?? '';
    case 'max_approvals_per_hour':
      return policy.maxApprovalsPerHour?.toString(10) ?? '';
    case 'allow_to':
      return policy.allowTo.join(',');
    case 'deny_kinds':
      return policy.denyKinds.join(',');
    case 'deny_delegatecall':
      return policy.denyDelegatecall ? 'true' : 'false';
    case 'require_abi_source':
      return policy.requireAbiSource.join(',');
    default: {
      const never: never = field;
      throw new Error(`unhandled policy field: ${String(never)}`);
    }
  }
}

/**
 * Serialise a policy, comments and all.
 *
 * Regenerating the commented form rather than rewriting bare keys is
 * deliberate: the comments are the only place the *reasoning* lives — why
 * `deny_delegatecall` should stay true, what `builtin` means — and a file
 * edited by a tool that quietly stripped them would get less safe every time
 * somebody changed a number.
 */
export function serializePolicy(policy: Policy): string {
  const list = (values: readonly string[]): string =>
    `[${values.map((v) => JSON.stringify(v)).join(', ')}]`;
  return `# QuaiVault CLI policy
#
# This file bounds what may be signed NON-INTERACTIVELY (agents, CI, --yes).
# An attended human at a TTY is not restricted by it.
#
# It is loaded from a fixed path. There is deliberately no flag to point
# elsewhere and no environment override — a bound the caller can move is not a
# bound. Violations exit 3 and name the rule.

# Largest value a single approval may move, in wei. Remove for no limit.
${
  policy.maxValuePerApprovalWei === undefined
    ? '# max_value_per_approval_wei = "1000000000000000000"'
    : `max_value_per_approval_wei = "${policy.maxValuePerApprovalWei.toString(10)}"`
}

# Rate limit on non-interactive approvals.
${
  policy.maxApprovalsPerHour === undefined
    ? '# max_approvals_per_hour = 5'
    : `max_approvals_per_hour = ${policy.maxApprovalsPerHour.toString(10)}`
}

# Recipients that may be approved non-interactively. Empty list = any address.
allow_to = ${list(policy.allowTo)}

# Transaction kinds refused outright. These change who controls the vault.
deny_kinds = ${list(policy.denyKinds)}

# DelegateCall lets the target rewrite vault storage. Keep this true.
deny_delegatecall = ${policy.denyDelegatecall ? 'true' : 'false'}

# Which decode provenances are trustworthy enough to sign unattended.
# "builtin" = an ABI the SDK vouches for. Anything else is a guess or a claim.
require_abi_source = ${list(policy.requireAbiSource)}
`;
}

export function savePolicy(policy: Policy, path = policyPath()): void {
  writeFileAtomic(path, serializePolicy(policy), 0o600);
}

/**
 * Apply one field to a policy, validating as we go.
 *
 * Returns a new policy; throws `Error` with a usable message on bad input. The
 * caller turns that into a `UsageError` — this module stays free of the CLI's
 * error types so it can be tested on its own.
 */
export function withPolicyField(policy: Policy, field: PolicyField, raw: string): Policy {
  const value = raw.trim();
  const csv = (): string[] =>
    value === ''
      ? []
      : value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  switch (field) {
    case 'max_value_per_approval_wei': {
      if (value === '') return { ...policy, maxValuePerApprovalWei: undefined };
      if (!/^\d+$/.test(value)) throw new Error('Expected a whole number of wei, or empty for no limit.');
      return { ...policy, maxValuePerApprovalWei: BigInt(value) };
    }
    case 'max_approvals_per_hour': {
      if (value === '') return { ...policy, maxApprovalsPerHour: undefined };
      if (!/^\d+$/.test(value)) throw new Error('Expected a whole number, or empty for no limit.');
      return { ...policy, maxApprovalsPerHour: Number(value) };
    }
    case 'allow_to': {
      const addresses = csv().map((a) => a.toLowerCase());
      const bad = addresses.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
      if (bad.length) throw new Error(`Not an address: ${bad.join(', ')}`);
      return { ...policy, allowTo: addresses };
    }
    case 'deny_kinds':
      return { ...policy, denyKinds: csv() };
    case 'deny_delegatecall': {
      if (value !== 'true' && value !== 'false') throw new Error('Expected true or false.');
      return { ...policy, denyDelegatecall: value === 'true' };
    }
    case 'require_abi_source': {
      const sources = csv();
      const bad = sources.filter((s) => !ABI_SOURCES.includes(s as AbiSource));
      if (bad.length) throw new Error(`Unknown decode provenance: ${bad.join(', ')}`);
      if (!sources.length) throw new Error('At least one provenance is required; "builtin" is the safe floor.');
      return { ...policy, requireAbiSource: sources as AbiSource[] };
    }
    default: {
      const never: never = field;
      throw new Error(`unhandled policy field: ${String(never)}`);
    }
  }
}

export interface PolicyCheckInput {
  value: bigint;
  to: string;
  kind: string;
  isDelegatecall: boolean;
  abiSource: AbiSource;
  approvalsLastHour: number;
}

/** Returns the violated rules. Empty means allowed. */
export function checkPolicy(policy: Policy, input: PolicyCheckInput): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (policy.maxValuePerApprovalWei !== undefined && input.value > policy.maxValuePerApprovalWei) {
    out.push(
      new PolicyViolation(
        'max_value_per_approval_wei',
        `Value ${input.value} wei exceeds the policy limit of ${policy.maxValuePerApprovalWei} wei.`,
      ),
    );
  }
  if (
    policy.maxApprovalsPerHour !== undefined &&
    input.approvalsLastHour >= policy.maxApprovalsPerHour
  ) {
    out.push(
      new PolicyViolation(
        'max_approvals_per_hour',
        `Already made ${input.approvalsLastHour} non-interactive approvals this hour; policy allows ${policy.maxApprovalsPerHour}.`,
      ),
    );
  }
  if (policy.allowTo.length > 0 && !policy.allowTo.includes(input.to.toLowerCase())) {
    out.push(
      new PolicyViolation('allow_to', `Recipient ${input.to} is not in the policy allowlist.`),
    );
  }
  if (policy.denyKinds.includes(input.kind)) {
    out.push(new PolicyViolation('deny_kinds', `Transaction kind "${input.kind}" is denied.`));
  }
  if (policy.denyDelegatecall && input.isDelegatecall) {
    out.push(
      new PolicyViolation('deny_delegatecall', 'DelegateCall is denied by policy.'),
    );
  }
  if (!policy.requireAbiSource.includes(input.abiSource)) {
    out.push(
      new PolicyViolation(
        'require_abi_source',
        `Decode provenance "${input.abiSource}" is not accepted; policy requires one of: ${policy.requireAbiSource.join(', ')}.`,
      ),
    );
  }
  return out;
}
