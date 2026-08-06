import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  POLICY_FIELDS,
  loadPolicy,
  policyValue,
  savePolicy,
  serializePolicy,
  withPolicyField,
  STARTER_POLICY,
  type Policy,
} from '../../src/context/policy.js';

function tmpPolicy(contents = STARTER_POLICY): string {
  const dir = mkdtempSync(join(tmpdir(), 'qv-policy-'));
  const path = join(dir, 'policy.toml');
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

const base = (): Policy => loadPolicy(tmpPolicy())!;

describe('editing one policy field', () => {
  it('round-trips through TOML unchanged when nothing is set', () => {
    const path = tmpPolicy();
    const before = loadPolicy(path)!;
    savePolicy(before, path);
    expect(loadPolicy(path)).toEqual(before);
  });

  /**
   * The comments are the only place the reasoning lives — why
   * `deny_delegatecall` should stay true, what `builtin` means. A writer that
   * stripped them would make the file less safe every time a number changed.
   */
  it('keeps the explanatory comments when it rewrites the file', () => {
    const path = tmpPolicy();
    savePolicy(withPolicyField(loadPolicy(path)!, 'max_approvals_per_hour', '9'), path);
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/DelegateCall lets the target rewrite vault storage/);
    expect(text).toMatch(/bounds what may be signed NON-INTERACTIVELY/i);
    expect(text).toMatch(/^max_approvals_per_hour = 9$/m);
  });

  it('accepts every displayed field as input, so show and set agree', () => {
    const policy = base();
    for (const field of POLICY_FIELDS) {
      const shown = policyValue(policy, field);
      expect(() => withPolicyField(policy, field, shown), field).not.toThrow();
    }
  });

  it('parses wei as a bigint and rejects anything else', () => {
    expect(withPolicyField(base(), 'max_value_per_approval_wei', '25').maxValuePerApprovalWei).toBe(
      25n,
    );
    expect(() => withPolicyField(base(), 'max_value_per_approval_wei', '1.5')).toThrow();
    expect(() => withPolicyField(base(), 'max_value_per_approval_wei', '-1')).toThrow();
  });

  it('treats an empty value as "no limit" rather than zero', () => {
    const p = withPolicyField(base(), 'max_value_per_approval_wei', '');
    expect(p.maxValuePerApprovalWei).toBeUndefined();
    expect(serializePolicy(p)).toMatch(/^# max_value_per_approval_wei/m);
  });

  it('rejects an allowlist entry that is not an address', () => {
    expect(() => withPolicyField(base(), 'allow_to', '0xnope')).toThrow(/Not an address/);
    const ok = withPolicyField(base(), 'allow_to', '0x' + 'ab'.repeat(20));
    expect(ok.allowTo).toEqual(['0x' + 'ab'.repeat(20)]);
  });

  it('rejects a decode provenance it does not know', () => {
    expect(() => withPolicyField(base(), 'require_abi_source', 'vibes')).toThrow(
      /Unknown decode provenance/,
    );
  });

  /**
   * `require_abi_source` empty would mean "sign anything, however it was
   * decoded" — the opposite of a bound, reached by clearing a field.
   */
  it('refuses to empty require_abi_source', () => {
    expect(() => withPolicyField(base(), 'require_abi_source', '')).toThrow(/at least one/i);
  });

  it('only accepts true or false for deny_delegatecall', () => {
    expect(withPolicyField(base(), 'deny_delegatecall', 'false').denyDelegatecall).toBe(false);
    expect(() => withPolicyField(base(), 'deny_delegatecall', 'no')).toThrow();
  });

  it('survives a loosening round-trip, so the file means what it says', () => {
    const path = tmpPolicy();
    savePolicy(withPolicyField(loadPolicy(path)!, 'deny_delegatecall', 'false'), path);
    expect(loadPolicy(path)!.denyDelegatecall).toBe(false);
  });
});
