import type { RecoveryRequest } from '@quaivault/sdk';
import type { AppContext } from '../context/context.js';
import type { Io } from './io.js';
import { span } from '../format/tone.js';
import { formatAbsolute, formatDuration } from '../format/index.js';
import type { JsonValue } from '../util/json.js';

/**
 * The pending-recovery alarm (plan §2.2 D).
 *
 * A pending social recovery is the highest-stakes state in the product: it
 * replaces the entire owner set. **Any command touching a vault with one
 * pending prints a red line naming the deadline and the exact cancel
 * invocation** — for an owner who runs the CLI occasionally that, not `qv
 * watch`, is the realistic defence, and it costs one extra read.
 */
export interface RecoveryAlarm {
  hash: string;
  vault: string;
  executableAt: number;
  executableNow: boolean;
  render(io: Io): void;
  toJson(): JsonValue;
}

export async function recoveryAlarm(ctx: AppContext, vault: string): Promise<RecoveryAlarm | null> {
  let pending: RecoveryRequest[];
  try {
    const recovery = ctx.qv.vault(vault).recovery;
    // `hasPending` is cheap; only pay for the detail when something is there.
    if (!(await recovery.hasPending())) return null;
    pending = await recovery.pending();
  } catch {
    // A vault with no recovery module, or an indexer that cannot answer, is
    // not an alarm condition — and must not break the command that asked.
    return null;
  }
  const first = pending[0];
  if (!first) return null;
  const hash = first.hash;
  const executableAt = first.executionTime;
  const now = ctx.now();
  const executableNow = executableAt > 0 && now >= executableAt;
  return {
    hash,
    vault,
    executableAt,
    executableNow,
    render(io: Io) {
      const left = executableAt - now;
      const when =
        executableAt === 0
          ? 'timing unknown'
          : left > 0
            ? `executable in ${formatDuration(left)} (${formatAbsolute(executableAt)})`
            : 'EXECUTABLE NOW';
      io.out(
        io.paint(
          span(`!! SOCIAL RECOVERY PENDING on this vault — ${when}`, 'danger'),
        ),
      );
      io.out(
        io.paint(
          span(
            '   If you did not expect this, any current owner can stop it:',
            'danger',
          ),
        ),
      );
      io.out(io.paint(span(`   qv recovery cancel ${vault} ${hash}`, 'danger')));
      io.out('');
    },
    toJson(): JsonValue {
      return { hash, executableAt: executableAt || null, executableNow };
    },
  };
}
