import { createInterface } from 'node:readline/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import type { AppContext } from '../context/context.js';
import { PreconditionError } from '../context/context.js';
import { policyPath } from '../context/policy.js';
import type { CommandSpec, WritePlan } from './spec.js';

/**
 * Confirmation sits between `plan()` and `commit()` and is owned by the
 * surface, not the command (plan §5.1).
 *
 * The rules it enforces:
 *
 * - `--yes` skips the prompt, **except** when the plan is flagged unverified
 *   (non-`builtin` decode, delegatecall, or failed decode) — those need a
 *   second explicit flag.
 * - No TTY and no `--yes` fails closed. Never hangs.
 * - Non-interactive signing requires a policy file to exist (plan §3.4). The
 *   trigger is non-interactivity, not `CI=true` — an environment variable must
 *   never silently grant fund-moving rights.
 */
export async function confirm(
  ctx: AppContext,
  planned: WritePlan,
  spec: CommandSpec,
): Promise<boolean> {
  const nonInteractive = ctx.flags.yes || !ctx.interactive;

  if (nonInteractive && ctx.policy === null) {
    throw new PreconditionError(
      'Non-interactive signing requires a policy file.',
      `Create ${policyPath()} with \`qv policy init\`, or run without --yes at a terminal.`,
    );
  }

  const unverified = (planned as { unverified?: boolean }).unverified === true;
  if (unverified && !ctx.flags.iUnderstandUnverified) {
    throw new PreconditionError(
      'This transaction could not be decoded from an ABI the SDK vouches for, ' +
        'or performs a delegatecall.',
      'Review the raw calldata above. If you understand it, re-run with --i-understand-unverified.',
    );
  }

  if (ctx.flags.yes) return true;

  if (!ctx.interactive) {
    throw new PreconditionError(
      'This command signs a transaction and needs confirmation, but there is no terminal.',
      'Re-run at a terminal, or pass --yes with a policy file in place.',
    );
  }

  spec.renderPlan?.(planned, ctx.io, ctx);
  return promptYesNo(`Sign and broadcast? [y/N] `);
}

/** Read a y/N answer from /dev/tty so a piped stdin cannot answer for the user. */
export async function promptYesNo(question: string): Promise<boolean> {
  const input = process.platform === 'win32' ? process.stdin : createReadStream('/dev/tty');
  const output = process.platform === 'win32' ? process.stderr : createWriteStream('/dev/tty');
  // readline can write to the tty after we destroy it on the way out, and an
  // unhandled 'error' event kills the process with ERR_STREAM_DESTROYED and a
  // stack trace, replacing whatever real error we were reporting.
  input.on('error', () => undefined);
  output.on('error', () => undefined);
  const rl = createInterface({ input, output, terminal: true });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
    if (input !== process.stdin) (input as { destroy: () => void }).destroy();
    if (output !== process.stderr) (output as { destroy: () => void }).destroy();
  }
}

/**
 * Does a typed confirmation match?
 *
 * Pure and exported so the comparison is testable without a terminal — the
 * prompt itself reads from `/dev/tty` and cannot be driven from a unit test.
 *
 * `foldCase` is for **addresses**, where EIP-55 casing is a *checksum* rather
 * than identity, so two spellings are the same value. Comparing them
 * case-sensitively rejects the checksummed form the tool itself printed:
 * observed with a real key, `qv key import` reported `0x0006506bDE71…` while
 * `qv key rm` demanded `0x0006506bde71…` and refused the address it had just
 * shown the user.
 *
 * **Aliases stay exact on purpose.** An alias is a name the user chose, and
 * `ops` and `OPS` can both exist in config, so folding them would make the
 * confirmation ambiguous about which one it is confirming — on
 * `qv recovery execute`, the most destructive command in the product.
 */
export function matchesTyped(
  given: string,
  expected: string,
  opts: { foldCase?: boolean } = {},
): boolean {
  const trimmed = given.trim();
  return opts.foldCase
    ? trimmed.toLowerCase() === expected.trim().toLowerCase()
    : trimmed === expected;
}

/** Typed confirmation for the highest-consequence actions. */
export async function promptTyped(
  question: string,
  expected: string,
  opts: { foldCase?: boolean } = {},
): Promise<boolean> {
  const input = process.platform === 'win32' ? process.stdin : createReadStream('/dev/tty');
  const output = process.platform === 'win32' ? process.stderr : createWriteStream('/dev/tty');
  input.on('error', () => undefined);
  output.on('error', () => undefined);
  const rl = createInterface({ input, output, terminal: true });
  try {
    return matchesTyped(await rl.question(question), expected, opts);
  } finally {
    rl.close();
    if (input !== process.stdin) (input as { destroy: () => void }).destroy();
    if (output !== process.stderr) (output as { destroy: () => void }).destroy();
  }
}
