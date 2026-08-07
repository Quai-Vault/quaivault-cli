import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { configHome } from './config.js';

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

/** Append only after a broadcast succeeds. The signing lock serializes writers. */
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
