import type { AppContext } from '../context/context.js';
import type { Io } from '../render/io.js';
import type { JsonValue } from '../util/json.js';
import type { ExitCodeValue } from './exit.js';

export interface ArgSpec {
  name: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

export interface OptionSpec {
  flags: string;
  description: string;
  defaultValue?: string | boolean | number;
  /** Choices are enforced by commander and surfaced in `--schema`. */
  choices?: readonly string[];
}

export interface Needs {
  /** Command signs; requires a key and passes through the policy layer. */
  signer?: boolean;
  /** Command needs an identity address (may come from config, not a key). */
  identity?: boolean;
  indexer?: 'required' | 'preferred';
}

/**
 * What a write produced. Every chain transaction we broadcast appears here
 * even on failure — that property is what lets an agent reconcile after a
 * crash (plan §4.1).
 */
export interface Step {
  name: string;
  status: 'ok' | 'failed' | 'skipped';
  chainTxHash?: string;
  error?: string;
}

export interface CommandResult<T = unknown> {
  data: T;
  /** Did this invocation cause a durable state change anywhere?
   *  `'unknown'` is required for broadcast-but-unconfirmed. */
  changed?: boolean | 'unknown';
  retryable?: boolean;
  steps?: Step[];
  /** Suggested next invocations, computed from affordances. */
  next?: string[];
  /** JSON Pointers to attacker-authored text within `data`. */
  untrusted?: string[];
  warnings?: string[];
  /** Override the default exit code (e.g. `execute` outcome `failed`). */
  exitCode?: ExitCodeValue;
}

/**
 * A write, split in two (plan §5.1).
 *
 * `plan()` is a pure read producing everything the pre-signature disclosure
 * needs. `commit()` signs and broadcasts. Confirmation lives *between* them and
 * is owned by the surface — readline in one-shot, a spawned child in the TUI,
 * `--yes`-or-fail-closed in JSON. This is what makes `--dry-run` free and the
 * disclosure a testable pure function rather than a print sequence.
 */
export interface WritePlan<P = unknown> {
  /** Rendered for the user before they commit. */
  disclosure: P;
  /** Stable hash of what is about to be signed, for `--expect-data-hash`. */
  dataHash?: string;
  /** Human-readable one-line summary of the action. */
  summary: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any --
 * The registry holds heterogeneous descriptors, so the defaults must be `any`
 * rather than `unknown`: with `unknown`, every call site would need a cast and
 * the type safety would move from the compiler to a convention. Each concrete
 * command supplies real types, which is where the checking actually happens. */
export interface CommandSpec<Input = any, Result = any, Plan = any> {
  /** e.g. ['tx', 'approve'] */
  path: string[];
  describe: string;
  args?: ArgSpec[];
  options?: OptionSpec[];
  needs?: Needs;
  /** Read commands implement `run`. */
  run?: (ctx: AppContext, input: Input, signal: AbortSignal) => Promise<CommandResult<Result>>;
  /** Write commands implement `plan` + `commit`. */
  plan?: (ctx: AppContext, input: Input, signal: AbortSignal) => Promise<WritePlan<Plan>>;
  commit?: (
    ctx: AppContext,
    planned: WritePlan<Plan>,
    input: Input,
    signal: AbortSignal,
  ) => Promise<CommandResult<Result>>;
  /** Human text. Never called under `--json`. */
  render: (result: CommandResult<Result>, io: Io, ctx: AppContext) => void;
  /** Render the disclosure between plan and commit. */
  renderPlan?: (planned: WritePlan<Plan>, io: Io, ctx: AppContext) => void;
  /** CLI-owned JSON shape. Never the SDK's types verbatim. */
  toJson: (result: CommandResult<Result>, ctx: AppContext) => JsonValue;
  /** Machine-readable description of `toJson`'s shape, for `qv --schema`. */
  outputSchema: JsonValue;
}

export function commandId(spec: CommandSpec): string {
  return spec.path.join(' ');
}
