import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configHome } from './config.js';
import { PreconditionError } from './context.js';

export interface OperationRecord {
  at: number;
  profile: string;
  key: string;
  fingerprint: string;
  command: string;
  vault: string;
  transactionHash: string;
  chainTxHash: string;
  state?: 'pending';
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
        const record = JSON.parse(line) as OperationRecord;
        if (!record || !Number.isFinite(record.at) ||
            ['profile', 'key', 'fingerprint', 'command', 'vault', 'transactionHash', 'chainTxHash'].some((field) => typeof record[field as keyof OperationRecord] !== 'string') ||
            (record.state !== undefined && record.state !== 'pending')) throw new Error('invalid record');
        return record;
      } catch (cause) {
        throw new Error(`Operation journal is corrupt at line ${index + 1}; refusing to deduplicate.`, {
          cause,
        });
      }
    });
  const found = records.reverse().find((record) => record.profile === profile && record.key === key);
  if (found?.state === 'pending') {
    throw new PreconditionError(
      `Idempotency key ${JSON.stringify(key)} has an unresolved submission.`,
      'Reconcile the vault and signer transaction history before repairing the pending journal entry. Do not resubmit under another key.',
    );
  }
  return found;
}

/** Atomic across keys and signers; a crash leaves a pending record, never a blank slate. */
export function reserveOperation(record: OperationRecord): OperationRecord | undefined {
  mkdirSync(configHome(), { recursive: true, mode: 0o700 });
  const lock = join(configHome(), '.operations.lock');
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); }
  catch { throw new PreconditionError('The operation journal is locked. Verify the other invocation has finished before retrying.'); }
  try {
    const prior = findOperation(record.profile, record.key);
    if (!prior) recordOperation({ ...record, state: 'pending' });
    return prior;
  } finally { closeSync(fd); unlinkSync(lock); }
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
