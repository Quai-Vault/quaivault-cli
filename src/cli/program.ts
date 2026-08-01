import { Command, Option } from 'commander';
import type { GlobalFlags } from '../context/context.js';
import { runCommand } from './middleware.js';
import { REGISTRY } from './registry.js';
import { commandId, type CommandSpec } from './spec.js';
import { ExitCode, type ExitCodeValue } from './exit.js';
import { buildSchema } from './schema.js';
import { completionScript, SHELLS, type Shell } from './completion.js';

declare const __CLI_VERSION__: string;
export const CLI_VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';

/**
 * Global flags are attached to the root *and* to every leaf, so both
 * `qv --json status` and `qv status --json` work. Option objects are stateful,
 * so each command needs its own instances.
 */
function globalOptions(): Option[] {
  return [
    new Option('--json', 'machine-readable output on stdout').default(false),
    new Option('-y, --yes', 'skip confirmation prompts').default(false),
    new Option('--no-input', 'never prompt; fail instead'),
    new Option('-q, --quiet', 'suppress hints and chrome').default(false),
    new Option('--debug', 'include stack traces on error').default(false),
    new Option('--wide', 'never truncate output').default(false),
    new Option('--color <mode>', 'colour output')
      .choices(['auto', 'always', 'never'])
      .default('auto'),
    new Option('-p, --profile <name>', 'configuration profile'),
    new Option('--vault <alias|address>', 'vault to act on'),
    new Option('--as <address>', 'act as this address (no key required)'),
    new Option('--dry-run', 'plan the write but do not sign or broadcast').default(false),
    new Option(
      '--i-understand-unverified',
      'permit signing a transaction whose decode is not SDK-verified, or a delegatecall',
    ).default(false),
  ];
}

/** Names commander derives from the global flags, used to strip them from input. */
const GLOBAL_KEYS = new Set([
  'json',
  'yes',
  'input',
  'quiet',
  'debug',
  'wide',
  'color',
  'profile',
  'vault',
  'as',
  'dryRun',
  'iUnderstandUnverified',
]);

function toFlags(raw: Record<string, unknown>): GlobalFlags {
  return {
    json: raw.json === true,
    yes: raw.yes === true,
    // commander maps --no-input to input:false
    noInput: raw.input === false,
    quiet: raw.quiet === true,
    debug: raw.debug === true,
    wide: raw.wide === true,
    color: (raw.color as GlobalFlags['color']) ?? 'auto',
    profile: typeof raw.profile === 'string' ? raw.profile : undefined,
    vault: typeof raw.vault === 'string' ? raw.vault : undefined,
    as: typeof raw.as === 'string' ? raw.as : undefined,
    dryRun: raw.dryRun === true,
    iUnderstandUnverified: raw.iUnderstandUnverified === true,
  };
}

function attach(program: Command, spec: CommandSpec, exitRef: { code: ExitCodeValue }): void {
  // Build the nested command path, creating intermediate groups on demand.
  let parent = program;
  for (const segment of spec.path.slice(0, -1)) {
    const existing = parent.commands.find((c) => c.name() === segment);
    parent = existing ?? parent.command(segment).description(`${segment} commands`);
  }
  const leaf = parent.command(spec.path[spec.path.length - 1] as string).description(spec.describe);

  for (const arg of spec.args ?? []) {
    const token = arg.variadic
      ? `${arg.required ? '<' : '['}${arg.name}...${arg.required ? '>' : ']'}`
      : `${arg.required ? '<' : '['}${arg.name}${arg.required ? '>' : ']'}`;
    leaf.argument(token, arg.description);
  }
  for (const opt of spec.options ?? []) {
    const o = new Option(opt.flags, opt.description);
    if (opt.choices) o.choices([...opt.choices]);
    if (opt.defaultValue !== undefined) o.default(opt.defaultValue);
    leaf.addOption(o);
  }
  for (const opt of globalOptions()) leaf.addOption(opt.hideHelp(true));

  leaf.action(async (...actionArgs: unknown[]) => {
    const cmd = actionArgs[actionArgs.length - 1] as Command;
    const localOpts = cmd.opts();
    const positional = actionArgs.slice(0, Math.max(0, actionArgs.length - 2));
    const input: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(localOpts)) {
      if (!GLOBAL_KEYS.has(k)) input[k] = v;
    }
    (spec.args ?? []).forEach((a, i) => {
      input[a.name] = positional[i];
    });
    // Leaf wins where explicitly set; the root carries anything given before
    // the subcommand name.
    const rootOpts = program.opts();
    const merged: Record<string, unknown> = { ...rootOpts };
    for (const key of GLOBAL_KEYS) {
      if (cmd.getOptionValueSource(key) === 'cli') merged[key] = localOpts[key];
    }
    exitRef.code = await runCommand({ spec, input, flags: toFlags(merged) });
  });
}

export function buildProgram(exitRef: { code: ExitCodeValue }): Command {
  const program = new Command();
  program
    .name('qv')
    .description('QuaiVault — multisig vaults on Quai Network')
    .version(CLI_VERSION, '-V, --version')
    .enablePositionalOptions()
    .showHelpAfterError(false)
    .exitOverride();

  for (const opt of globalOptions()) program.addOption(opt);

  program
    .command('--schema', { hidden: true })
    .description('emit the machine-readable command and output schema')
    .action(() => {
      process.stdout.write(`${JSON.stringify(buildSchema(CLI_VERSION), null, 2)}\n`);
    });

  // Not a CommandSpec: it emits a shell script to stdout and touches no
  // config, no client and no keystore, so routing it through the dispatcher
  // would mean building a context it has no use for.
  program
    .command('completion')
    .argument('<shell>', `one of: ${SHELLS.join(', ')}`)
    .description('Emit a shell completion script (add to your shell config)')
    .action((shell: string) => {
      if (!(SHELLS as readonly string[]).includes(shell)) {
        process.stderr.write(`error: unknown shell ${JSON.stringify(shell)}\n`);
        process.stderr.write(`       supported: ${SHELLS.join(', ')}\n`);
        exitRef.code = ExitCode.Usage;
        return;
      }
      process.stdout.write(completionScript(shell as Shell));
    });

  for (const spec of REGISTRY) attach(program, spec, exitRef);

  program.configureHelp({
    formatHelp: (cmd, helper) => formatGroupedHelp(cmd, helper),
  });

  return program;
}

function formatGroupedHelp(cmd: Command, helper: ReturnType<Command['createHelp']>): string {
  const lines: string[] = [];
  lines.push(helper.commandDescription(cmd) || '');
  lines.push('');
  lines.push(`Usage: ${helper.commandUsage(cmd)}`);
  lines.push('');
  const subcommands = helper.visibleCommands(cmd);
  if (subcommands.length) {
    lines.push('Commands:');
    for (const sub of subcommands) {
      lines.push(`  ${sub.name().padEnd(18)} ${helper.subcommandDescription(sub)}`);
    }
    lines.push('');
  }
  const options = helper.visibleOptions(cmd);
  if (options.length) {
    lines.push('Options:');
    for (const opt of options) {
      lines.push(`  ${helper.optionTerm(opt).padEnd(30)} ${helper.optionDescription(opt)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export { ExitCode, commandId };
