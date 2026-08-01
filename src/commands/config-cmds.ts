import { inspectAddress } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError } from '../context/context.js';
import { loadConfig, saveConfig, configPath } from '../context/config.js';
import { policyPath, writeStarterPolicy, loadPolicy } from '../context/policy.js';
import { span } from '../format/tone.js';
import { safeText } from '../format/index.js';

const NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function assertName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new UsageError(
      `Invalid name ${JSON.stringify(name)}.`,
      'Names may contain letters, digits, dot, underscore and hyphen, up to 64 characters.',
    );
  }
  return name;
}

function assertUsableAddress(address: string, role: string): string {
  const check = inspectAddress(address);
  if (!check.valid) {
    throw new UsageError(
      `Not a usable Quai address for ${role}: ${address}`,
      `zone ${check.zone ?? '?'} · ledger ${check.ledger ?? '?'} — ${check.reason ?? 'invalid'}`,
    );
  }
  return address;
}

export const useCommand: CommandSpec<
  { target?: string; as?: string },
  { vault?: string; address?: string }
> = {
  path: ['use'],
  describe: 'Set the default vault, or the identity you act as',
  args: [{ name: 'target', description: 'vault alias or address to make default' }],

  async run(ctx, input) {
    const config = loadConfig();
    const profile = config.profiles[config.defaultProfile]!;
    // `--as` is a global flag; when present on `use` it means "persist this".
    const asAddress = ctx.flags.as;
    if (!input.target && !asAddress) {
      throw new UsageError(
        'Nothing to set.',
        'Pass a vault alias/address, or --as 0x… to set the identity you act as.',
      );
    }
    if (asAddress) {
      profile.address = assertUsableAddress(asAddress, 'identity');
    }
    if (input.target) {
      const resolved = config.aliases[safeText(input.target, 64)] ?? input.target;
      profile.vault = assertUsableAddress(resolved, 'vault');
    }
    saveConfig(config);
    return { data: { vault: profile.vault, address: profile.address }, changed: true };
  },

  render(result, io) {
    if (result.data.address) io.out(`identity   ${result.data.address}`);
    if (result.data.vault) io.out(`vault      ${result.data.vault}`);
    io.err(`saved to ${configPath()}`);
  },
  toJson: (r) => ({ vault: r.data.vault ?? null, address: r.data.address ?? null }),
  outputSchema: {
    type: 'object',
    properties: { vault: { type: ['string', 'null'] }, address: { type: ['string', 'null'] } },
  },
};

export const aliasCommand: CommandSpec<
  { action?: string; name?: string; address?: string },
  { aliases: Record<string, string> }
> = {
  path: ['alias'],
  describe: 'Name a vault so you stop pasting 42 hex characters',
  args: [
    { name: 'action', description: 'add | rm | ls' },
    { name: 'name', description: 'alias name' },
    { name: 'address', description: 'vault address (for add)' },
  ],

  async run(_ctx, input) {
    const config = loadConfig();
    const action = input.action ?? 'ls';
    if (action === 'add') {
      if (!input.name || !input.address) {
        throw new UsageError('Usage: qv alias add <name> <address>');
      }
      config.aliases[assertName(input.name)] = assertUsableAddress(input.address, 'vault');
      saveConfig(config);
    } else if (action === 'rm') {
      if (!input.name) throw new UsageError('Usage: qv alias rm <name>');
      delete config.aliases[assertName(input.name)];
      saveConfig(config);
    } else if (action !== 'ls') {
      throw new UsageError(`Unknown action ${JSON.stringify(action)}. Use add, rm or ls.`);
    }
    return { data: { aliases: config.aliases }, changed: action !== 'ls' };
  },

  render(result, io) {
    const entries = Object.entries(result.data.aliases);
    if (!entries.length) {
      io.out('  No aliases. Add one:  qv alias add treasury 0x…');
      return;
    }
    for (const [name, addr] of entries) io.out(`  ${name.padEnd(16)} ${addr}`);
  },
  toJson: (r) => ({ aliases: r.data.aliases }),
  outputSchema: { type: 'object', properties: { aliases: { type: 'object' } } },
};

export const contactCommand: CommandSpec<
  { action?: string; name?: string; address?: string },
  { contacts: Record<string, string> }
> = {
  path: ['contact'],
  describe: 'Name co-owners so you can tell who signed',
  args: [
    { name: 'action', description: 'add | rm | ls' },
    { name: 'name', description: 'contact name' },
    { name: 'address', description: 'owner address (for add)' },
  ],

  async run(_ctx, input) {
    const config = loadConfig();
    const action = input.action ?? 'ls';
    if (action === 'add') {
      if (!input.name || !input.address) {
        throw new UsageError('Usage: qv contact add <name> <address>');
      }
      config.contacts[assertName(input.name)] = assertUsableAddress(input.address, 'contact');
      saveConfig(config);
    } else if (action === 'rm') {
      if (!input.name) throw new UsageError('Usage: qv contact rm <name>');
      delete config.contacts[assertName(input.name)];
      saveConfig(config);
    } else if (action !== 'ls') {
      throw new UsageError(`Unknown action ${JSON.stringify(action)}. Use add, rm or ls.`);
    }
    return { data: { contacts: config.contacts }, changed: action !== 'ls' };
  },

  render(result, io) {
    const entries = Object.entries(result.data.contacts);
    if (!entries.length) {
      io.out('  No contacts. Without these, tx show prints indistinguishable hex.');
      io.out('  qv contact add bob 0x…');
      return;
    }
    for (const [name, addr] of entries) io.out(`  ${name.padEnd(16)} ${addr}`);
  },
  toJson: (r) => ({ contacts: r.data.contacts }),
  outputSchema: { type: 'object', properties: { contacts: { type: 'object' } } },
};

export const policyCommand: CommandSpec<
  { action?: string },
  { path: string; exists: boolean; created: boolean }
> = {
  path: ['policy'],
  describe: 'The bound on non-interactive signing',
  args: [{ name: 'action', description: 'init | show' }],

  async run(_ctx, input) {
    const action = input.action ?? 'show';
    const path = policyPath();
    if (action === 'init') {
      if (loadPolicy(path)) {
        throw new UsageError(
          `A policy already exists at ${path}.`,
          'Edit it directly; this command will not overwrite it.',
        );
      }
      writeStarterPolicy(path);
      return { data: { path, exists: true, created: true }, changed: true };
    }
    if (action !== 'show') throw new UsageError('Usage: qv policy [init|show]');
    return { data: { path, exists: loadPolicy(path) !== null, created: false }, changed: false };
  },

  render(result, io) {
    const { path, exists, created } = result.data;
    if (created) {
      io.out(`created ${path}`);
      io.err('');
      io.err('  Read it before relying on it. It bounds what may be signed');
      io.err('  non-interactively — agents, CI, and any --yes invocation.');
      return;
    }
    io.out(`policy   ${exists ? path : io.paint(span('none', 'warn'))}`);
    if (!exists) {
      io.err('');
      io.err('  Attended signing works without one. Non-interactive signing does not.');
      io.err('  qv policy init');
    }
  },
  toJson: (r) => ({ path: r.data.path, exists: r.data.exists, created: r.data.created }),
  outputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      exists: { type: 'boolean' },
      created: { type: 'boolean' },
    },
  },
};

export const addrCheckCommand: CommandSpec<
  { address: string },
  ReturnType<typeof inspectAddress>
> = {
  path: ['addr', 'check'],
  describe: 'Check an address before committing it to a role',
  args: [{ name: 'address', description: 'address to inspect', required: true }],

  async run(_ctx, input) {
    return { data: inspectAddress(input.address), changed: false };
  },

  render(result, io) {
    const c = result.data;
    io.out(`  ${c.valid ? io.paint(span('usable', 'ok')) : io.paint(span('NOT usable', 'danger'))}`);
    io.out(`    zone     ${c.zone ?? '(none)'}`);
    io.out(`    ledger   ${c.ledger ?? '(unknown)'}`);
    if (!c.valid) {
      io.out(`    reason   ${c.reason ?? 'invalid'}`);
      io.err('');
      io.err('  QuaiVault is on the Quai ledger, which is the EVM side of the network.');
      io.err('  Qi is UTXO and executes no contracts, so a Qi address can never sign or');
      io.err('  approve — it is dead weight against your threshold, and enough of them');
      io.err('  brick the vault permanently. This is not a limitation of the CLI.');
    }
  },
  toJson: (r) => ({
    valid: r.data.valid,
    zone: r.data.zone ?? null,
    ledger: r.data.ledger ?? null,
    reason: r.data.reason ?? null,
  }),
  outputSchema: {
    type: 'object',
    properties: {
      valid: { type: 'boolean' },
      zone: { type: ['string', 'null'] },
      ledger: { type: ['string', 'null'] },
      reason: { type: ['string', 'null'] },
    },
  },
};
