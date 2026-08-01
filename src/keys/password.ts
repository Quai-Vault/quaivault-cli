import { readFileSync } from 'node:fs';
import password from '@inquirer/password';
import { UsageError, PreconditionError } from '../context/context.js';

/**
 * Password input uses a library (plan §3.6).
 *
 * Revision 2 proposed ~80 lines of hand-rolled raw-mode TTY handling to keep
 * third-party code out of the keystroke path. That trades a large, subtle
 * correctness surface — echo restoration across every signal and exit path,
 * backspace, Ctrl-C, Ctrl-U, resize — for a marginal supply-chain gain.
 *
 * `@inquirer/password` shares its core with the prompts already in the stack,
 * so it is one dependency family rather than two.
 */

export const MIN_PASSWORD_LENGTH = 12;

export interface PasswordSource {
  /** Non-interactive: read from a file whose path came from the environment. */
  file?: string;
  interactive: boolean;
}

export function resolvePasswordSource(interactive: boolean): PasswordSource {
  const file = process.env.QUAIVAULT_KEYSTORE_PASSWORD_FILE;
  return { file: file && file.trim() !== '' ? file : undefined, interactive };
}

function readPasswordFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new UsageError(
      `Could not read QUAIVAULT_KEYSTORE_PASSWORD_FILE at ${path}.`,
      (err as Error).message,
    );
  }
  const value = raw.replace(/\r?\n$/, '');
  if (value === '') throw new UsageError(`Password file ${path} is empty.`);
  return value;
}

/** Prompt for an existing password, or read one non-interactively. */
export async function readPassword(source: PasswordSource, promptText = 'Password: '): Promise<string> {
  if (source.file) return readPasswordFile(source.file);
  if (!source.interactive) {
    throw new PreconditionError(
      'A keystore password is required and there is no terminal to ask on.',
      'Set QUAIVAULT_KEYSTORE_PASSWORD_FILE, or run at a terminal.',
    );
  }
  return password({ message: promptText, mask: true });
}

/** Prompt twice for a new password, with a floor and a plain warning. */
export async function readNewPassword(source: PasswordSource): Promise<string> {
  if (source.file) {
    const value = readPasswordFile(source.file);
    assertStrongEnough(value);
    return value;
  }
  if (!source.interactive) {
    throw new PreconditionError(
      'Setting a keystore password requires a terminal.',
      'Set QUAIVAULT_KEYSTORE_PASSWORD_FILE, or run at a terminal.',
    );
  }
  const first = await password({ message: 'New password: ', mask: true });
  assertStrongEnough(first);
  const second = await password({ message: 'Repeat password: ', mask: true });
  if (first !== second) throw new UsageError('Passwords did not match.');
  return first;
}

export function assertStrongEnough(value: string): void {
  if (value.length < MIN_PASSWORD_LENGTH) {
    throw new UsageError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      'There is no recovery: a forgotten password is a permanently lost signing seat.',
    );
  }
}
