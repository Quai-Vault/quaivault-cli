import { spawn } from 'node:child_process';

/**
 * Act by delegating to a one-shot invocation of ourselves (plan §4.4).
 *
 * The TUI never loads a keystore. On an action it unmounts Ink, hands the
 * terminal to `process.execPath` with one-shot argv, and **the child reads the
 * password itself from /dev/tty**. The TUI must never broker the password —
 * piping it in would put the key's precursor back in this address space and
 * defeat the whole design.
 *
 * Why not hold a key here: `kill -USR1 <pid>` starts the V8 inspector on any
 * Node process and serves the debugger URL to anything on loopback with no
 * authentication — a full heap read. Against a one-shot process that is a
 * ~50 ms race; against a TUI sitting unlocked it is a certainty. `tmux detach`
 * also sends no signal at all, so idle/suspend locking mostly never fires.
 *
 * **All three streams are inherited, deliberately.** §4.4 sketched spawning
 * with `--json` and parsing the result, but that hides the child's output —
 * and the child's output is the §7 pre-signature disclosure and its
 * confirmation prompt. Piping stdout while inheriting stdin produces the worst
 * possible state: the child asks a question the user cannot see and waits for
 * an answer to it. Inheriting everything means the reviewer sees exactly what
 * a one-shot user sees, which is the strongest parity guarantee available, and
 * costs only the structured result — which the exit code already carries.
 */
export interface SpawnOutcome {
  ok: boolean;
  exitCode: number;
  message: string;
}

/** The one-shot exit codes, read back into something worth showing. */
function describe(code: number): { ok: boolean; message: string } {
  switch (code) {
    case 0:
      return { ok: true, message: 'done' };
    case 2:
      return { ok: false, message: 'usage error' };
    case 3:
      return { ok: false, message: 'refused: precondition or policy' };
    case 4:
      return { ok: false, message: 'not executed — approved, or timelock started' };
    case 5:
      return { ok: false, message: 'declined' };
    case 130:
      return { ok: false, message: 'interrupted' };
    default:
      return { ok: false, message: `failed (exit ${code})` };
  }
}

/**
 * Hold the primary screen until the user presses a key.
 *
 * The child writes its failure to the primary screen — we are suspended, so
 * the alternate screen is not active — and then Ink re-enters the alternate
 * screen and forces a redraw the instant the child exits. The message is in
 * scrollback but the user is looking at the TUI again, so in practice it is
 * unreadable: all they see is the footer's `describe()` summary, and
 * "refused: precondition or policy" covers everything from a wrong password
 * to a policy allowlist to a key that does not match the identity.
 *
 * Called only on failure. A success has already told the user what happened,
 * through the confirmation they just answered.
 *
 * Restores stdin exactly as `pauseInput` left it — paused and unref'd — so
 * Ink's `resumeInput` finds the state it expects.
 */
export async function holdUntilAcknowledged(message: string): Promise<void> {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) return;
  process.stdout.write(message);
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      stdin.off('data', finish);
      stdin.pause();
      stdin.unref();
      resolve();
    };
    stdin.ref();
    stdin.resume();
    stdin.once('data', finish);
  });
}

export async function spawnSigner(argv: string[]): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1] as string, ...argv], {
      // The child owns the terminal outright while it runs.
      stdio: 'inherit',
      env: {
        ...process.env,
        // Belt and braces: a spawned signer must not inherit a plaintext key
        // from our environment (§3.5).
        QUAIVAULT_PRIVATE_KEY: undefined,
      },
    });
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolve({ exitCode, ...describe(exitCode) });
    });
    child.on('error', (err) => {
      resolve({ ok: false, exitCode: 1, message: err.message });
    });
  });
}
