import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configHome } from './config.js';
import { PolicyViolation } from './policy.js';

interface JournalEntry {
  at: number;
  profile: string;
  action: string;
  vault: string;
  transactionHash: string;
  chainTxHash: string;
}

const JOURNAL = 'policy-actions.jsonl';

function journalPath(): string {
  return join(configHome(), JOURNAL);
}

function entries(): JournalEntry[] {
  try {
    return readFileSync(journalPath(), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line, index) => {
        try {
          const value = JSON.parse(line) as JournalEntry;
          if (!Number.isFinite(value.at)) throw new Error('missing timestamp');
          return value;
        } catch (cause) {
          throw new Error(
            `Policy action journal is corrupt at line ${index + 1}; refusing unattended approval.`,
            { cause },
          );
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export function recentPolicyActionCount(profile: string, action: string, now: number): number {
  const after = now - 3600;
  return entries().filter((entry) => entry.profile === profile && entry.action === action && entry.at >= after)
    .length;
}

/** Reserve before signing: timeouts and competing keys must still consume budget. */
export function reservePolicyAction(entry: JournalEntry, max?: number): void {
  mkdirSync(configHome(), { recursive: true, mode: 0o700 });
  const lock = join(configHome(), '.policy-actions.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new PolicyViolation('max_approvals_per_hour', 'The policy journal is locked; verify no other invocation is reserving approval budget before retrying.'); }
  try {
    if (max !== undefined && recentPolicyActionCount(entry.profile, entry.action, entry.at) >= max) {
      throw new PolicyViolation('max_approvals_per_hour', 'The hourly approval budget has been consumed or reserved.');
    }
    recordPolicyAction(entry);
  } finally { closeSync(fd); unlinkSync(lock); }
}

/** Append a durable action or reservation. */
export function recordPolicyAction(entry: JournalEntry): void {
  mkdirSync(configHome(), { recursive: true, mode: 0o700 });
  const fd = openSync(journalPath(), 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(entry)}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
