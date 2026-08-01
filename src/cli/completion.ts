import { REGISTRY } from './registry.js';
import { commandId, type CommandSpec } from './spec.js';

/**
 * Shell completion (plan §5.2).
 *
 * A traversal of the registry, exactly like `--schema`, so a new command is
 * completable the moment it is registered and there is no second list to
 * forget.
 *
 * **Static, and that is a privacy decision rather than a limitation.** §4.2's
 * rule for `--schema` — "never enumerating configured aliases, contacts, or
 * paths" — applies with more force here, because a completion script is
 * *written to a file on disk and sourced by every shell*. Baking a user's
 * vault aliases and contact names into `~/.bashrc`'s world would put the
 * names of the vaults someone holds into backups, dotfile repositories and
 * screen shares, forever, for the benefit of saving a few keystrokes.
 *
 * Dynamic completion of aliases is possible later by shelling out to
 * `qv alias ls` at completion time — the important thing is that it is never
 * baked into the emitted script.
 */

export const SHELLS = ['bash', 'zsh', 'fish'] as const;
export type Shell = (typeof SHELLS)[number];

/** Global flags, duplicated from program.ts's `globalOptions` by name only. */
const GLOBAL_FLAGS = [
  '--json',
  '-y',
  '--yes',
  '--no-input',
  '-q',
  '--quiet',
  '--debug',
  '--wide',
  '--color',
  '-p',
  '--profile',
  '--vault',
  '--as',
  '--dry-run',
  '--i-understand-unverified',
  '-h',
  '--help',
];

/** Every flag token a command accepts, long and short, without arguments. */
function flagsOf(spec: CommandSpec): string[] {
  const out: string[] = [];
  for (const opt of spec.options ?? []) {
    for (const token of opt.flags.split(/[\s,]+/)) {
      if (token.startsWith('-')) out.push(token);
    }
  }
  return out;
}

interface Entry {
  /** Space-joined command path, e.g. `tx approve`. */
  command: string;
  describe: string;
  flags: string[];
}

export function completionEntries(): Entry[] {
  return REGISTRY.map((spec) => ({
    command: commandId(spec),
    // Descriptions reach a shell's completion display. They are authored in
    // this repo, never fetched, but newlines would still corrupt the emitted
    // script — so collapse them rather than trusting the source.
    describe: spec.describe.replace(/\s+/g, ' ').trim(),
    flags: flagsOf(spec),
  }));
}

/** Top-level words: the first segment of every registered path, deduplicated. */
function topLevel(entries: Entry[]): string[] {
  return [...new Set(entries.map((e) => e.command.split(' ')[0]!))].sort();
}

/** Second-level words grouped by their parent, for `qv tx <TAB>`. */
function subcommands(entries: Entry[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const entry of entries) {
    const [head, second] = entry.command.split(' ');
    if (!head || !second) continue;
    const list = out.get(head) ?? [];
    if (!list.includes(second)) list.push(second);
    out.set(head, list);
  }
  for (const list of out.values()) list.sort();
  return out;
}

function bash(entries: Entry[]): string {
  const subs = subcommands(entries);
  const cases = [...subs]
    .map(([head, children]) => `    ${head}) COMPREPLY=($(compgen -W "${children.join(' ')}" -- "$cur")); return;;`)
    .join('\n');
  const flagsByCommand = entries
    .filter((e) => e.flags.length)
    .map((e) => `    "${e.command}") echo "${e.flags.join(' ')}";;`)
    .join('\n');

  return `# quaivault completion for bash. Regenerate with: qv completion bash
_qv_flags_for() {
  case "$1" in
${flagsByCommand}
  esac
}

_qv_complete() {
  local cur prev words
  cur="\${COMP_WORDS[COMP_CWORD]}"
  words="\${COMP_WORDS[@]:1:COMP_CWORD-1}"

  if [[ "$cur" == -* ]]; then
    COMPREPLY=($(compgen -W "${GLOBAL_FLAGS.join(' ')} $(_qv_flags_for "$words")" -- "$cur"))
    return
  fi

  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=($(compgen -W "${topLevel(entries).join(' ')} completion help" -- "$cur"))
    return
  fi

  case "\${COMP_WORDS[1]}" in
${cases}
  esac
}
complete -F _qv_complete qv quaivault
`;
}

function zsh(entries: Entry[]): string {
  // One _describe per level, so zsh shows the command descriptions rather
  // than a bare word list.
  const top = topLevel(entries)
    .map((word) => {
      const exact = entries.find((e) => e.command === word);
      const describe = exact?.describe ?? `${word} commands`;
      return `    '${word}:${escapeZsh(describe)}'`;
    })
    .join('\n');

  const subs = [...subcommands(entries)]
    .map(([head, children]) => {
      const lines = children
        .map((child) => {
          const entry = entries.find((e) => e.command === `${head} ${child}`);
          return `        '${child}:${escapeZsh(entry?.describe ?? child)}'`;
        })
        .join('\n');
      return `      ${head})\n        _values '${head} command' \\\n${lines.replace(/\n/g, ' \\\n')}\n        ;;`;
    })
    .join('\n');

  return `#compdef qv quaivault
# quaivault completion for zsh. Regenerate with: qv completion zsh

_qv() {
  local -a top
  top=(
${top}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' top
    return
  fi

  case "\${words[2]}" in
${subs}
  esac

  _arguments '*:: :->args' \\
    ${GLOBAL_FLAGS.filter((f) => f.startsWith('--')).map((f) => `'${f}'`).join(' \\\n    ')}
}

_qv "$@"
`;
}

function fish(entries: Entry[]): string {
  const lines: string[] = [
    '# quaivault completion for fish. Regenerate with: qv completion fish',
    '',
    '# No file completion: every argument is a subcommand, address or hash.',
    'complete -c qv -f',
    'complete -c quaivault -f',
    '',
  ];
  for (const word of topLevel(entries)) {
    const exact = entries.find((e) => e.command === word);
    lines.push(
      `complete -c qv -n __fish_use_subcommand -a ${word} -d ${escapeFish(exact?.describe ?? `${word} commands`)}`,
    );
  }
  lines.push('');
  for (const [head, children] of subcommands(entries)) {
    for (const child of children) {
      const entry = entries.find((e) => e.command === `${head} ${child}`);
      lines.push(
        `complete -c qv -n "__fish_seen_subcommand_from ${head}" -a ${child} -d ${escapeFish(entry?.describe ?? child)}`,
      );
    }
  }
  lines.push('');
  for (const flag of GLOBAL_FLAGS.filter((f) => f.startsWith('--'))) {
    lines.push(`complete -c qv -l ${flag.slice(2)}`);
  }
  return lines.join('\n') + '\n';
}

/** Single quotes terminate a zsh description; a colon splits value from label. */
function escapeZsh(text: string): string {
  return text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

function escapeFish(text: string): string {
  return `'${text.replace(/'/g, "\\'")}'`;
}

export function completionScript(shell: Shell): string {
  const entries = completionEntries();
  switch (shell) {
    case 'bash':
      return bash(entries);
    case 'zsh':
      return zsh(entries);
    case 'fish':
      return fish(entries);
    default: {
      const never: never = shell;
      throw new Error(`unhandled shell: ${String(never)}`);
    }
  }
}
