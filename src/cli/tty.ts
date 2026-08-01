import { openSync, closeSync } from 'node:fs';

/**
 * Whether we may prompt.
 *
 * Based on `/dev/tty` being openable, **not** `process.stdin.isTTY`: an agent
 * running `qv … | jq` has a TTY stdin and a piped stdout, and the password
 * reader goes to /dev/tty anyway (plan §3.5).
 */
export function canPrompt(): boolean {
  if (process.platform === 'win32') return Boolean(process.stdin.isTTY);
  try {
    const fd = openSync('/dev/tty', 'r');
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to run under a debugger or a code-injecting NODE_OPTIONS.
 *
 * `NODE_OPTIONS` flags never appear in `process.execArgv`, so checking
 * execArgv alone catches nothing that matters — and `--inspect` is not even
 * the worst vector: `NODE_OPTIONS="--require ./evil.cjs"` executes arbitrary
 * code before a line of ours runs. An allow-list is not worth maintaining
 * (plan §3.5).
 */
export function assertNoDebugger(): void {
  const nodeOptions = process.env.NODE_OPTIONS;
  if (nodeOptions && nodeOptions.trim() !== '') {
    throw new Error(
      `Refusing to run with NODE_OPTIONS set (${JSON.stringify(nodeOptions)}).\n` +
        '  NODE_OPTIONS can inject code (--require) or open a debugger (--inspect) before\n' +
        '  this process starts. Unset it and re-run.',
    );
  }
  if (process.env.NODE_V8_COVERAGE) {
    throw new Error('Refusing to run with NODE_V8_COVERAGE set: it writes process state to disk.');
  }
  const injected = process.execArgv.filter((a) => a.startsWith('--inspect'));
  if (injected.length > 0) {
    throw new Error(`Refusing to run with an inspector flag: ${injected.join(' ')}`);
  }
}

/**
 * Suppress V8 inspector activation via SIGUSR1.
 *
 * `kill -USR1 <pid>` starts the inspector on any Node process and serves the
 * debugger URL to anything on loopback with no authentication — a full heap
 * read, including key material. Installing a listener suppresses it. Node
 * documents this only as "might interfere with the debugger", so it is defence
 * in depth rather than the control (plan §3.5) — the real control is that key
 * material lives for milliseconds in a one-shot process.
 */
export function guardAgainstInspector(): void {
  if (process.platform === 'win32') return;
  process.on('SIGUSR1', () => {
    /* intentionally empty: presence of a listener is the point */
  });
}
