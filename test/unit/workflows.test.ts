import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Phase 0's exit criterion: "every action SHA-pinned by lint, not review."
 *
 * A tag is a mutable pointer. `actions/checkout@v4` resolves to whatever the
 * tag points at the moment CI runs, so a compromised or retagged release
 * executes in a job that holds `id-token: write` and publishes to npm. This
 * is the only thing standing between that and a human noticing during review,
 * so it lives in the default test gate rather than in a CI-only script.
 */

const WORKFLOW_DIR = join(import.meta.dirname, '../../.github/workflows');

const workflowFiles = readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));

interface UseSite {
  file: string;
  line: number;
  ref: string;
  raw: string;
}

function usesIn(file: string): UseSite[] {
  const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
  const out: UseSite[] = [];
  text.split('\n').forEach((raw, i) => {
    const m = /^\s*-?\s*uses:\s*(\S+)/.exec(raw);
    if (m?.[1]) out.push({ file, line: i + 1, ref: m[1], raw });
  });
  return out;
}

const allUses = workflowFiles.flatMap(usesIn);

describe('workflow action pinning', () => {
  it('finds workflows to check at all', () => {
    // Guards against the check silently passing because the glob broke.
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(allUses.length).toBeGreaterThan(0);
  });

  it.each(allUses.map((u) => [`${u.file}:${u.line} ${u.ref}`, u] as const))(
    'pins %s to a full commit SHA',
    (_label, use) => {
      // Local composite actions (./.github/actions/foo) have no ref to pin.
      if (use.ref.startsWith('./')) return;
      const at = use.ref.lastIndexOf('@');
      expect(at, `${use.file}:${use.line} has no @ref`).toBeGreaterThan(0);
      const ref = use.ref.slice(at + 1);
      expect(ref, `${use.file}:${use.line} is not a 40-char commit SHA`).toMatch(
        /^[0-9a-f]{40}$/,
      );
    },
  );

  it.each(allUses.map((u) => [`${u.file}:${u.line}`, u] as const))(
    'leaves a human-readable version comment on %s',
    (_label, use) => {
      // A bare SHA is unreviewable. Dependabot writes and maintains this
      // comment, so requiring it also proves Dependabot is what moved the pin.
      if (use.ref.startsWith('./')) return;
      expect(use.raw, `${use.file}:${use.line} needs a trailing # vX.Y.Z comment`).toMatch(
        /#\s*v?\d+(\.\d+)*/,
      );
    },
  );
});

describe('workflow permissions', () => {
  it.each(workflowFiles)('declares an explicit top-level permissions block in %s', (file) => {
    // Without one, the job inherits the repository default, which may be
    // write-all. Least privilege has to be stated to exist.
    const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
    expect(text).toMatch(/^permissions:/m);
  });

  it('grants id-token: write only in the release workflow', () => {
    // OIDC trusted publishing is the one place that needs it. Anywhere else
    // it is a token-minting primitive attached to a job that has no use for
    // one -- most dangerously in a workflow triggered by pull_request.
    for (const file of workflowFiles) {
      const text = readFileSync(join(WORKFLOW_DIR, file), 'utf8');
      if (/id-token:\s*write/.test(text)) {
        expect(file, 'id-token: write outside release.yml').toBe('release.yml');
        expect(text, 'release must not be triggered by pull_request').not.toMatch(
          /^\s*pull_request:/m,
        );
      }
    }
  });
});
