import { CommanderError } from 'commander';
import { buildProgram, CLI_VERSION } from '../cli/program.js';
import { ExitCode, type ExitCodeValue } from '../cli/exit.js';
import { guardAgainstInspector } from '../cli/tty.js';
import { createIo } from '../render/io.js';
import { normalizeError, renderError } from '../render/errors.js';
import { renderWelcome } from '../render/welcome.js';

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
      process.stderr.write(`${err.message}\n`);
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

main()
  .then((code) => {
    if (!interrupted) process.exitCode = code;
  })
  .catch((err: unknown) => {
    // Last-resort funnel. Never prints a raw error object: a quais provider
    // error carries the full JSON-RPC request body on `.info.payload`, and
    // Node's default printing walks the cause chain.
    const io = createIo({});
    renderError(normalizeError(err), io, process.env.QUAIVAULT_DEBUG === '1', err);
    process.exitCode = ExitCode.Failure;
  });
