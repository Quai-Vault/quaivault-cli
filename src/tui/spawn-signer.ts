import { spawn } from 'node:child_process';

/**
 * Sign by delegating to a one-shot invocation of ourselves.
 *
 * The TUI never loads a keystore. On confirm it leaves the alternate screen and
 * spawns `process.execPath` with the one-shot argv; **the child reads the
 * password itself from /dev/tty**. The TUI must never broker the password —
 * piping it in would put the key's precursor back in this address space and
 * defeat the whole design.
 *
 * Why not hold a key here: `kill -USR1 <pid>` starts the V8 inspector on any
 * Node process and serves the debugger URL to anything on loopback with no
 * authentication — a full heap read. Against a one-shot process that is a
 * ~50 ms race; against a TUI sitting unlocked it is a certainty. `tmux detach`
 * also sends no signal at all, so idle/suspend locking mostly never fires.
 */
export interface SignOutcome {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function spawnSigner(argv: string[]): Promise<SignOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] as string, ...argv], {
      // stdin inherited so the child can reach the terminal for its own
      // password prompt; we never write to it.
      stdio: ['inherit', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Belt and braces: a spawned signer must not inherit a plaintext key
        // from our environment.
        QUAIVAULT_PRIVATE_KEY: undefined,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('close', (code) => {
      resolve({ ok: code === 0, exitCode: code ?? 1, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: 1, stdout: '', stderr: err.message });
    });
  });
}
