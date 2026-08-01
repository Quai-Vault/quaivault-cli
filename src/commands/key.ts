import { readFileSync } from 'node:fs';
import { getBytes, isKeystoreJson, decryptKeystoreJson, SigningKey, Wallet } from 'quais';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError, PreconditionError } from '../context/context.js';
import { loadConfig, saveConfig } from '../context/config.js';
import { span } from '../format/tone.js';
import {
  assertKeyName,
  assertQuaiLedgerAddress,
  assertSaneKdf,
  keyExists,
  keyPath,
  listKeys,
  readKeystoreJson,
  reencrypt,
  removeKey,
  saveKey,
  type KeyEntry,
} from '../keys/keystore.js';
import {
  readNewPassword,
  readPassword,
  resolvePasswordSource,
} from '../keys/password.js';
import { promptTyped } from '../cli/confirm.js';

const HEX_KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Read raw key material without ever letting it reach `argv`.
 *
 * `/proc/*./cmdline` is world-readable and rewriting `process.argv` does not
 * change it, so there is deliberately no `--private-key` flag — a permanent
 * non-goal asserted by a registry test.
 */
async function readRawKey(
  input: { keyFile?: string; keyFd?: string },
  interactive: boolean,
): Promise<Uint8Array> {
  let text: string | undefined;
  if (input.keyFile) {
    text = readFileSync(input.keyFile, 'utf8');
  } else if (input.keyFd) {
    text = readFileSync(Number(input.keyFd), 'utf8');
  } else if (interactive) {
    const { default: password } = await import('@inquirer/password');
    text = await password({ message: 'Private key (hex): ', mask: true });
  } else {
    throw new PreconditionError(
      'No key material supplied and no terminal to ask on.',
      'Use --keystore <file>, --key-file <path>, --key-fd <n>, or run at a terminal.',
    );
  }
  const trimmed = text.trim();
  if (!HEX_KEY_RE.test(trimmed)) {
    throw new UsageError(
      'That is not a 32-byte hex private key.',
      'Expected 64 hex characters, optionally 0x-prefixed.',
    );
  }
  return getBytes(trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`);
}

export const keyImportCommand: CommandSpec<
  {
    name: string;
    keystore?: string;
    keyFile?: string;
    keyFd?: string;
    acceptWeakKdf?: boolean;
    use?: boolean;
  },
  KeyEntry
> = {
  path: ['key', 'import'],
  describe: 'Import a private key or an existing V3 keystore',
  args: [{ name: 'name', description: 'name for this key', required: true }],
  options: [
    { flags: '--keystore <file>', description: 'import an existing V3 keystore JSON file' },
    { flags: '--key-file <path>', description: 'read a raw hex private key from a file' },
    { flags: '--key-fd <n>', description: 'read a raw hex private key from a file descriptor' },
    {
      flags: '--accept-weak-kdf',
      description: 'accept an imported keystore with scrypt N below the safe floor',
      defaultValue: false,
    },
    { flags: '--use', description: 'make this the active key', defaultValue: false },
  ],

  async run(ctx, input) {
    const name = assertKeyName(input.name);
    if (keyExists(name)) {
      throw new UsageError(
        `A key named ${JSON.stringify(name)} already exists.`,
        'This command never overwrites. Remove it first with `qv key rm`.',
      );
    }
    const source = resolvePasswordSource(ctx.interactive);

    let entry: KeyEntry;
    if (input.keystore) {
      // Re-encrypt under our own password so every key in the directory has
      // consistent, validated parameters.
      const json = readFileSync(input.keystore, 'utf8');
      if (!isKeystoreJson(json)) throw new UsageError(`${input.keystore} is not a V3 keystore.`);
      assertSaneKdf(json, input.acceptWeakKdf === true);
      const existing = await readPassword(source, 'Password for the imported keystore: ');
      const account = await decryptKeystoreJson(json, existing).catch(() => {
        throw new PreconditionError('Could not decrypt that keystore.', 'Wrong password?');
      });
      const bytes = getBytes(account.privateKey);
      assertQuaiLedgerAddress(new Wallet(new SigningKey(bytes)).address);
      const next = await readNewPassword(resolvePasswordSource(ctx.interactive));
      entry = await saveKey(name, bytes, next);
      bytes.fill(0);
    } else {
      const bytes = await readRawKey(input, ctx.interactive);
      // Validate the zone at import, not at first use — otherwise a user
      // imports a key, sees success, and discovers mid-signature that it can
      // never transact.
      assertQuaiLedgerAddress(new Wallet(new SigningKey(bytes)).address);
      const next = await readNewPassword(source);
      entry = await saveKey(name, bytes, next);
      bytes.fill(0);
    }

    if (input.use) {
      const config = loadConfig();
      const profile = config.profiles[config.defaultProfile]!;
      profile.key = name;
      profile.address = entry.address;
      saveConfig(config);
    }
    return { data: entry, changed: true };
  },

  render(result, io) {
    io.out(`imported ${result.data.name}   ${result.data.address}`);
    io.err('');
    io.err(`  Stored at ${result.data.path} (mode 600).`);
    io.err('  Back up that file. There is no recovery for a forgotten password —');
    io.err('  it is a permanently lost signing seat.');
  },
  toJson: (r) => ({ name: r.data.name, address: r.data.address, path: r.data.path }),
  outputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, address: { type: 'string' }, path: { type: 'string' } },
  },
};

export const keyLsCommand: CommandSpec<Record<string, never>, { keys: KeyEntry[]; active?: string }> = {
  path: ['key', 'ls'],
  describe: 'List keys in the keystore',

  async run(ctx) {
    return { data: { keys: listKeys(), active: ctx.profile.key }, changed: false };
  },
  render(result, io) {
    if (!result.data.keys.length) {
      io.out('  No keys. Import one:  qv key import <name>');
      return;
    }
    for (const k of result.data.keys) {
      const active = k.name === result.data.active ? io.paint(span('  *active', 'accent')) : '';
      io.out(`  ${k.name.padEnd(16)} ${k.address}${active}`);
    }
  },
  toJson: (r) => ({
    active: r.data.active ?? null,
    keys: r.data.keys.map((k) => ({ name: k.name, address: k.address })),
  }),
  outputSchema: {
    type: 'object',
    properties: { active: { type: ['string', 'null'] }, keys: { type: 'array' } },
  },
};

export const keyUseCommand: CommandSpec<{ name: string }, { name: string; address: string }> = {
  path: ['key', 'use'],
  describe: 'Make a key the active signer',
  args: [{ name: 'name', description: 'key name', required: true }],

  async run(_ctx, input) {
    const name = assertKeyName(input.name);
    const entry = listKeys().find((k) => k.name === name);
    if (!entry) throw new UsageError(`No key named ${JSON.stringify(name)}.`);
    const config = loadConfig();
    const profile = config.profiles[config.defaultProfile]!;
    profile.key = name;
    profile.address = entry.address;
    saveConfig(config);
    return { data: { name, address: entry.address }, changed: true };
  },
  render: (r, io) => io.out(`active key   ${r.data.name}   ${r.data.address}`),
  toJson: (r) => ({ name: r.data.name, address: r.data.address }),
  outputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, address: { type: 'string' } },
  },
};

export const keyRmCommand: CommandSpec<{ name: string }, { name: string; removed: boolean }> = {
  path: ['key', 'rm'],
  describe: 'Delete a key from the keystore',
  args: [{ name: 'name', description: 'key name', required: true }],

  async run(ctx, input) {
    const name = assertKeyName(input.name);
    const entry = listKeys().find((k) => k.name === name);
    if (!entry) throw new UsageError(`No key named ${JSON.stringify(name)}.`);

    // Deleting a key is a one-command path to losing a signing seat, so it
    // takes a typed confirmation of the address — never a bare y/N.
    if (!ctx.flags.yes) {
      if (!ctx.interactive) {
        throw new PreconditionError(
          'Deleting a key needs confirmation and there is no terminal.',
          'Re-run at a terminal, or pass --yes if you are certain.',
        );
      }
      ctx.io.err(`About to permanently delete ${name} (${entry.address}).`);
      ctx.io.err('If this is your only copy, the signing seat is gone for good.');
      const ok = await promptTyped(`Type the address to confirm: `, entry.address);
      if (!ok) throw new UsageError('Address did not match. Nothing was deleted.');
    }
    removeKey(name);
    return { data: { name, removed: true }, changed: true };
  },
  render: (r, io) => io.out(`removed ${r.data.name}`),
  toJson: (r) => ({ name: r.data.name, removed: r.data.removed }),
  outputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, removed: { type: 'boolean' } },
  },
};

export const keyChangePasswordCommand: CommandSpec<{ name: string }, { name: string }> = {
  path: ['key', 'change-password'],
  describe: 'Re-encrypt a key under a new password',
  args: [{ name: 'name', description: 'key name', required: true }],

  async run(ctx, input) {
    const name = assertKeyName(input.name);
    if (!keyExists(name)) throw new UsageError(`No key named ${JSON.stringify(name)}.`);
    const source = resolvePasswordSource(ctx.interactive);
    const current = await readPassword(source, 'Current password: ');
    const next = await readNewPassword({ interactive: ctx.interactive });
    await reencrypt(name, current, next);
    return { data: { name }, changed: true };
  },
  render: (r, io) => io.out(`re-encrypted ${r.data.name} with a fresh salt and IV`),
  toJson: (r) => ({ name: r.data.name }),
  outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
};

export const keyExportCommand: CommandSpec<{ name: string }, { name: string; json: string }> = {
  path: ['key', 'export'],
  describe: 'Print the V3 keystore JSON for a key (still encrypted)',
  args: [{ name: 'name', description: 'key name', required: true }],

  async run(_ctx, input) {
    const name = assertKeyName(input.name);
    if (!keyExists(name)) throw new UsageError(`No key named ${JSON.stringify(name)}.`);
    // Exports the *encrypted* keystore only. There is deliberately no
    // plaintext export: V3 covers every legitimate migration case.
    return { data: { name, json: readKeystoreJson(name) }, changed: false };
  },
  render: (r, io) => io.out(r.data.json.trimEnd()),
  toJson: (r) => ({ name: r.data.name, keystore: JSON.parse(r.data.json) as never }),
  outputSchema: {
    type: 'object',
    properties: { name: { type: 'string' }, keystore: { type: 'object' } },
  },
};

export const keyPathCommand: CommandSpec<{ name: string }, { path: string }> = {
  path: ['key', 'path'],
  describe: 'Print the on-disk path of a key',
  args: [{ name: 'name', description: 'key name', required: true }],
  async run(_ctx, input) {
    return { data: { path: keyPath(input.name) }, changed: false };
  },
  render: (r, io) => io.out(r.data.path),
  toJson: (r) => ({ path: r.data.path }),
  outputSchema: { type: 'object', properties: { path: { type: 'string' } } },
};
