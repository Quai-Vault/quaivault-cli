import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { configHome } from './config.js';

export interface OperationRecord {
  at: number;
  profile: string;
  key: string;
  fingerprint: string;
  command: string;
  vault: string;
  transactionHash: string;
  chainTxHash: string;
}

const FILE = 'operations.jsonl';

function path(): string {
  return join(configHome(), FILE);
}

export function findOperation(profile: string, key: string): OperationRecord | undefined {
  let text: string;
  try {
    text = readFileSync(path(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  const records = text
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as OperationRecord;
      } catch (cause) {
        throw new Error(`Operation journal is corrupt at line ${index + 1}; refusing to deduplicate.`, {
          cause,
        });
      }
    });
  return records.reverse().find((record) => record.profile === profile && record.key === key);
}

/** Signing locks serialize appenders for a profile/key in normal operation. */
export function recordOperation(record: OperationRecord): void {
  mkdirSync(configHome(), { recursive: true, mode: 0o700 });
  const fd = openSync(path(), 'a', 0o600);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
