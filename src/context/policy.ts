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
