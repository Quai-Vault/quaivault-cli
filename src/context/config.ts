import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { safeText } from '../format/index.js';

export type NetworkName = 'mainnet' | 'testnet';

export interface Profile {
  network: NetworkName;
  /** Watch-only identity. In Phase 2 this is also the active key's address. */
  address?: string;
  rpcUrl?: string;
  indexerUrl?: string;
  /** Active key name in the keystore. */
  key?: string;
  vault?: string;
}

export interface CliConfig {
  defaultProfile: string;
  profiles: Record<string, Profile>;
  aliases: Record<string, string>;
  contacts: Record<string, string>;
}

export const DEFAULT_CONFIG: CliConfig = {
  defaultProfile: 'default',
  profiles: { default: { network: 'mainnet' } },
  aliases: {},
  contacts: {},
};

export function configHome(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && xdg.trim() !== '') return join(xdg, 'quaivault');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'quaivault');
  }
  return join(homedir(), '.quaivault');
}

export function configPath(): string {
  return join(configHome(), 'config.toml');
}

/**
 * Atomic write: temp in the same directory, fsync the file, rename, then
 * **fsync the directory**. Skipping the directory fsync means a crash can
 * leave no file at all (plan §3.5) — for a keystore that is a lost signing
 * seat, and the same rule applies to every file we write.
 */
export function writeFileAtomic(path: string, contents: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}`);
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dirFd = openSync(dir, 'r');
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function sanitizeNameMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(raw))) {
    if (typeof v !== 'string') continue;
    // Names come from a file that may be shared or hostile — sanitize on read,
    // not just on render, so nothing downstream can forget.
    const name = safeText(k, 64);
    if (name) out[name] = v;
  }
  return out;
}

export function loadConfig(path = configPath()): CliConfig {
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(path, 'utf8'));
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Could not read config at ${path}: ${e.message}`);
  }
  const obj = asRecord(raw);
  const profilesRaw = asRecord(obj.profiles);
  const profiles: Record<string, Profile> = {};
  for (const [name, value] of Object.entries(profilesRaw)) {
    const p = asRecord(value);
    const network = p.network === 'testnet' ? 'testnet' : 'mainnet';
    profiles[safeText(name, 64) || 'default'] = {
      network,
      address: typeof p.address === 'string' ? p.address : undefined,
      rpcUrl: typeof p.rpc_url === 'string' ? p.rpc_url : undefined,
      indexerUrl: typeof p.indexer_url === 'string' ? p.indexer_url : undefined,
      key: typeof p.key === 'string' ? safeText(p.key, 64) : undefined,
      vault: typeof p.vault === 'string' ? p.vault : undefined,
    };
  }
  if (Object.keys(profiles).length === 0) profiles.default = { network: 'mainnet' };
  const defaultProfile =
    typeof obj.default_profile === 'string' && profiles[obj.default_profile]
      ? obj.default_profile
      : (Object.keys(profiles)[0] as string);
  return {
    defaultProfile,
    profiles,
    aliases: sanitizeNameMap(obj.aliases),
    contacts: sanitizeNameMap(obj.contacts),
  };
}

export function saveConfig(config: CliConfig, path = configPath()): void {
  const profiles: Record<string, Record<string, string>> = {};
  for (const [name, p] of Object.entries(config.profiles)) {
    const entry: Record<string, string> = { network: p.network };
    if (p.address) entry.address = p.address;
    if (p.rpcUrl) entry.rpc_url = p.rpcUrl;
    if (p.indexerUrl) entry.indexer_url = p.indexerUrl;
    if (p.key) entry.key = p.key;
    if (p.vault) entry.vault = p.vault;
    profiles[name] = entry;
  }
  const doc: Record<string, unknown> = {
    default_profile: config.defaultProfile,
    profiles,
  };
  if (Object.keys(config.aliases).length) doc.aliases = config.aliases;
  if (Object.keys(config.contacts).length) doc.contacts = config.contacts;
  writeFileAtomic(path, `${stringifyToml(doc)}\n`, 0o600);
}
