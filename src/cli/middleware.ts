import { loadConfig, type CliConfig, type Profile } from '../context/config.js';
import { loadPolicy, policyPath } from '../context/policy.js';
import { createClient, createClock, type SkewState } from '../context/client.js';
import {
  UsageError,
  PreconditionError,
  type AppContext,
  type GlobalFlags,
} from '../context/context.js';
import { createIo, type Io } from '../render/io.js';
import { normalizeError, errorToJson, renderError } from '../render/errors.js';
import { envelope, jsonSafe, SCHEMA_VERSION } from '../util/json.js';
import { safeText } from '../format/index.js';
import { ExitCode, exitCodeForErrorCode, type ExitCodeValue } from './exit.js';
import { canPrompt } from './tty.js';
import { commandId, type CommandSpec } from './spec.js';
import { confirm } from './confirm.js';
import { resolveSigner, type SignerResolution } from '../keys/signer.js';

export interface RunOptions {
  spec: CommandSpec;
  input: Record<string, unknown>;
  flags: GlobalFlags;
  io?: Io;
  signal?: AbortSignal;
}

function resolveProfile(config: CliConfig, flags: GlobalFlags): { name: string; profile: Profile } {
  const name = flags.profile ?? process.env.QUAIVAULT_PROFILE ?? config.defaultProfile;
  const profile = config.profiles[name];
  if (!profile) {
    throw new UsageError(
      `No profile named ${JSON.stringify(name)}.`,
      `Known profiles: ${Object.keys(config.profiles).join(', ') || '(none)'}`,
    );
  }
  return { name, profile };
}

function buildContext(flags: GlobalFlags, io: Io, held: { signer?: SignerResolution }): AppContext {
  const config = loadConfig();
  const { name: profileName, profile } = resolveProfile(config, flags);
  const skew: SkewState = { offsetSeconds: 0, detected: false };
  const now = createClock(skew);
  const qv = createClient({ profile, now });
  const policy = loadPolicy();
  const interactive = canPrompt() && !flags.noInput;

  const reverseContacts = new Map<string, string>();
  for (const [name, addr] of Object.entries(config.contacts)) {
    reverseContacts.set(addr.toLowerCase(), name);
  }

  return {
    qv,
    config,
    profile,
    profileName,
    flags,
    io,
    now,
    skew,
    policy,
    interactive,
    resolveVault(nameOrAddress) {
      const candidate = nameOrAddress ?? flags.vault ?? process.env.QUAIVAULT_VAULT ?? profile.vault;
      if (!candidate) {
        throw new UsageError(
          'No vault specified.',
          'Pass one as an argument, set a default with `qv use <alias>`, or export QUAIVAULT_VAULT.',
        );
      }
      const alias = config.aliases[safeText(candidate, 64)];
      return alias ?? candidate;
    },
    contactName(address) {
      return reverseContacts.get(address.toLowerCase());
    },
    identity() {
      return flags.as ?? process.env.QUAIVAULT_ADDRESS ?? profile.address;
    },
    async requireSigner() {
      if (held.signer) return { signer: held.signer.signer, address: held.signer.address };
      const provider = (qv as unknown as { connection?: { provider?: unknown } }).connection
        ?.provider;
      const resolved = await resolveSigner(profile, provider, interactive);
      held.signer = resolved;
      // The signer must be able to act, and a mismatch between the configured
      // identity and the unlocked key means someone would sign as the wrong
      // owner — which is a fund-loss bug, not a UX quirk.
      const declared = flags.as ?? profile.address;
      if (declared && declared.toLowerCase() !== resolved.address.toLowerCase()) {
        throw new PreconditionError(
          `The unlocked key is ${resolved.address}, but you are acting as ${declared}.`,
          'Run `qv key use <name>` to match them, or pass --as with the key\'s address.',
        );
      }
      return { signer: resolved.signer, address: resolved.address };
    },
  };
}

/**
 * The one place that resolves config, connects, checks preconditions,
 * dispatches `--json` vs `render`, funnels errors, and sets the exit code.
 *
 * A new command is a descriptor plus a registry line — never a copy of this.
 */
export async function runCommand(opts: RunOptions): Promise<ExitCodeValue> {
  const io =
    opts.io ??
    createIo({
      color: opts.flags.color,
      ...(opts.flags.wide ? { width: 10_000 } : {}),
    });
  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;
  const id = commandId(opts.spec);
  const held: { signer?: SignerResolution } = {};
  let ctx: AppContext | undefined;

  try {
    ctx = buildContext(opts.flags, io, held);

    if (opts.spec.needs?.identity && !ctx.identity()) {
      throw new UsageError(
        'This command needs to know which address you are acting as.',
        'Set one with `qv use --as 0x…`, pass --as, or export QUAIVAULT_ADDRESS. No key required.',
      );
    }

    let result;
    if (opts.spec.run) {
      result = await opts.spec.run(ctx, opts.input, signal);
    } else if (opts.spec.plan && opts.spec.commit) {
      const planned = await opts.spec.plan(ctx, opts.input, signal);

      if (opts.flags.dryRun) {
        if (!opts.flags.json) {
          opts.spec.renderPlan?.(planned, io, ctx);
          io.err('');
          io.err('dry run — nothing was signed or broadcast.');
        } else {
          io.out(
            envelope({
              schema: SCHEMA_VERSION,
              ok: true,
              command: id,
              changed: false,
              retryable: true,
              data: jsonSafe({ dryRun: true, ...planned }),
            }),
          );
        }
        return ExitCode.Ok;
      }

      const approved = await confirm(ctx, planned, opts.spec);
      if (!approved) {
        if (!opts.flags.json) io.err('aborted — nothing was signed.');
        else
          io.out(
            envelope({
              schema: SCHEMA_VERSION,
              ok: false,
              command: id,
              changed: false,
              retryable: true,
              error: { code: 'DECLINED', message: 'User declined at the confirmation prompt.' },
            }),
          );
        return ExitCode.Declined;
      }

      result = await opts.spec.commit(ctx, planned, opts.input, signal);
    } else {
      throw new Error(`Command "${id}" implements neither run nor plan/commit.`);
    }

    if (opts.flags.json) {
      io.out(
        envelope({
          schema: SCHEMA_VERSION,
          ok: true,
          command: id,
          changed: result.changed,
          retryable: result.retryable,
          // jsonSafe at the single choke point: every command's toJson is
          // safe by construction, not by each author remembering.
          data: jsonSafe(opts.spec.toJson(result, ctx)),
          steps: result.steps ? jsonSafe(result.steps) : undefined,
          next: result.next ? jsonSafe(result.next) : undefined,
          untrusted: result.untrusted,
          warnings: result.warnings,
        }),
      );
    } else {
      opts.spec.render(result, io, ctx);
      if (!opts.flags.quiet && result.next?.length && io.isTty) {
        io.err('');
        for (const n of result.next) io.err(`  ${n}`);
      }
      for (const w of result.warnings ?? []) io.err(`warning: ${w}`);
    }
    return result.exitCode ?? ExitCode.Ok;
  } catch (err) {
    const e = normalizeError(err);
    const code =
      err instanceof UsageError
        ? ExitCode.Usage
        : err instanceof PreconditionError
          ? ExitCode.Precondition
          : exitCodeForErrorCode(e.code);
    if (opts.flags.json) {
      // Error envelope goes to **stdout**, not stderr: empty stdout makes a
      // structured error indistinguishable from a crash (plan §4.1).
      io.out(
        envelope({
          schema: SCHEMA_VERSION,
          ok: false,
          command: id,
          changed: false,
          error: errorToJson(e),
        }),
      );
    } else {
      renderError(e, io, opts.flags.debug, err);
    }
    return code;
  } finally {
    // Release the signing lock and drop key material on every exit path,
    // including a throw.
    held.signer?.release();
  }
}

export { policyPath };
