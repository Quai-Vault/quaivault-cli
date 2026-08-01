import type { CommandSpec } from './spec.js';
import { statusCommand } from '../commands/status.js';
import { vaultShowCommand, vaultLsCommand, vaultReceiveCommand } from '../commands/vault.js';
import { txShowCommand, txLsCommand, txHistoryCommand, txWaitCommand } from '../commands/tx-read.js';
import { inboxCommand, inboxCountCommand } from '../commands/inbox.js';
import {
  txApproveCommand,
  txUnapproveCommand,
  txExecuteCommand,
  txCancelCommand,
  txExpireCommand,
} from '../commands/tx-write.js';
import { doctorCommand } from '../commands/doctor.js';
import { PROPOSE_COMMANDS } from '../commands/propose.js';
import { RECOVERY_COMMANDS } from '../commands/recovery.js';
import { vaultCreateCommand, mineSaltCommand } from '../commands/vault-create.js';
import { watchCommand } from '../commands/watch.js';
import { tuiCommand } from '../commands/tui.js';
import { balanceCommand, messagesCommand } from '../commands/balance.js';
import {
  keyImportCommand,
  keyLsCommand,
  keyUseCommand,
  keyRmCommand,
  keyChangePasswordCommand,
  keyExportCommand,
  keyPathCommand,
} from '../commands/key.js';
import {
  useCommand,
  aliasCommand,
  contactCommand,
  policyCommand,
  addrCheckCommand,
} from '../commands/config-cmds.js';

/**
 * The one list of commands.
 *
 * `qv --help` grouping, shell completion, and `qv --schema` are all traversals
 * of this array — which is also the test: if any of the three is hard to
 * generate, imperative logic has leaked into a descriptor.
 */
export const REGISTRY: CommandSpec[] = [
  statusCommand,
  vaultShowCommand,
  vaultLsCommand,
  vaultReceiveCommand,
  txShowCommand,
  txLsCommand,
  txHistoryCommand,
  txWaitCommand,
  inboxCommand,
  inboxCountCommand,
  doctorCommand,
  useCommand,
  aliasCommand,
  contactCommand,
  policyCommand,
  addrCheckCommand,
  balanceCommand,
  messagesCommand,
  keyImportCommand,
  keyLsCommand,
  keyUseCommand,
  keyRmCommand,
  keyChangePasswordCommand,
  keyExportCommand,
  keyPathCommand,
  txApproveCommand,
  txUnapproveCommand,
  txExecuteCommand,
  txCancelCommand,
  txExpireCommand,
  ...PROPOSE_COMMANDS,
  ...RECOVERY_COMMANDS,
  vaultCreateCommand,
  mineSaltCommand,
  watchCommand,
  tuiCommand,
];

/** Groups for `--help`. Forty flat commands is unusable. */
export const HELP_GROUPS: { title: string; match: (spec: CommandSpec) => boolean }[] = [
  {
    title: 'Reading (no key required)',
    match: (s) =>
      ['status', 'doctor', 'inbox', 'vault', 'tx', 'balance', 'messages', 'addr'].includes(
        s.path[0] ?? '',
      ) && s.needs?.signer !== true,
  },
  { title: 'Acting on transactions', match: (s) => s.path[0] === 'tx' && s.needs?.signer === true },
  { title: 'Proposing changes', match: (s) => s.path[0] === 'propose' },
  {
    title: 'Vault administration',
    match: (s) => ['module', 'recovery'].includes(s.path[0] ?? ''),
  },
  {
    title: 'Setup',
    match: (s) => ['key', 'use', 'alias', 'contact', 'policy', 'config', 'completion'].includes(s.path[0] ?? ''),
  },
];

export function findSpec(path: string[]): CommandSpec | undefined {
  return REGISTRY.find(
    (s) => s.path.length === path.length && s.path.every((p, i) => p === path[i]),
  );
}
