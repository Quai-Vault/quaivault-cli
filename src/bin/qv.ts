import { CommanderError } from 'commander';
import { buildProgram, CLI_VERSION } from '../cli/program.js';
import { ExitCode, type ExitCodeValue } from '../cli/exit.js';
import { guardAgainstInspector } from '../cli/tty.js';
import { createIo } from '../render/io.js';
import { normalizeError, renderError } from '../render/errors.js';
import { renderWelcome } from '../render/welcome.js';
import { envelope, SCHEMA_VERSION } from '../util/json.js';

async function main(): Promise<ExitCodeValue> {
  guardAgainstInspector();

  const exitRef: { code: ExitCodeValue } = { code: ExitCode.Ok };
  const argv = process.argv.slice(2);

  // Bare `qv` is a state-aware hint screen, never a help wall and never the
  // TUI — an agent running `qv` must not land in a full-screen app (plan §4.4).
  if (argv.length === 0) {
    renderWelcome(createIo({}), CLI_VERSION);
    return ExitCode.Ok;
  }

  const program = buildProgram(exitRef);
  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version print themselves and exit 0
      if (err.code === 'commander.helpDisplayed' || err.code === 'commander.help') return ExitCode.Ok;
      if (err.code === 'commander.version') return ExitCode.Ok;
      if (argv.includes('--json')) {
        process.stdout.write(
          `${envelope({
            schema: SCHEMA_VERSION,
            ok: false,
            command: 'parse',
            changed: false,
            retryable: false,
            error: { code: 'VALIDATION', message: err.message },
          })}\n`,
        );
      }
      return ExitCode.Usage;
    }
    throw err;
  }
  return exitRef.code;
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  process.exitCode = ExitCode.Interrupted;
  process.exit(ExitCode.Interrupted);
});

async function flushOutput(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.end(() => resolve())),
    new Promise<void>((resolve) => process.stderr.end(() => resolve())),
  ]);
}

main()
  .then(async (code) => {
    if (interrupted) return;
    process.exitCode = code;
    // SDK clients own provider/transport handles that are intentionally not
    // exposed for disposal. A completed one-shot command must still terminate;
    // flush both streams first so explicit exit cannot truncate piped JSON.
    await flushOutput();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    // Last-resort funnel. Never prints a raw error object: a quais provider
    // error carries the full JSON-RPC request body on `.info.payload`, and
    // Node's default printing walks the cause chain.
    const io = createIo({});
    renderError(normalizeError(err), io, process.env.QUAIVAULT_DEBUG === '1', err);
    process.exitCode = ExitCode.Failure;
    await flushOutput();
    process.exit(ExitCode.Failure);
  });
