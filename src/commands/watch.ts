import type { WatchEvent, WatchTopic, Subscription } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError } from '../context/context.js';
import { span } from '../format/tone.js';
import { safeText } from '../format/index.js';
import { jsonSafe } from '../util/json.js';

const TOPICS: WatchTopic[] = [
  'transactions',
  'confirmations',
  'owners',
  'modules',
  'deposits',
  'tokenTransfers',
  'recoveries',
  'signedMessages',
];

/**
 * A headless event stream. **There is deliberately no `--exec`.**
 *
 * Running a command on a chain event would put attacker-influenceable payloads
 * (a token name, a revert string, a raw indexer row) into a shell we spawned.
 * `qv watch --json | your-script` covers the same ground and leaves the exec
 * risk where the user can see it.
 *
 * This is a long-lived process: it prints a visible heartbeat and reconnect
 * lines, because a silent watch is indistinguishable from a broken one.
 */
export const watchCommand: CommandSpec<
  { vault?: string; topics?: string },
  { events: number }
> = {
  path: ['watch'],
  describe: 'Stream vault events until interrupted',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  options: [
    {
      flags: '--topics <list>',
      description: `comma-separated: ${TOPICS.join(',')}`,
    },
  ],
  needs: { indexer: 'required' },

  async run(ctx, input, signal) {
    const address = ctx.resolveVault(input.vault);
    const topics = input.topics
      ? input.topics.split(',').map((t) => t.trim())
      : undefined;
    if (topics) {
      const bad = topics.filter((t) => !TOPICS.includes(t as WatchTopic));
      if (bad.length) {
        throw new UsageError(
          `Unknown topic(s): ${bad.join(', ')}`,
          `Valid topics: ${TOPICS.join(', ')}`,
        );
      }
    }

    let count = 0;
    const vault = ctx.qv.vault(address);

    await new Promise<void>((resolve) => {
      const sub: { current?: Subscription } = {};
      const stop = (): void => {
        void sub.current?.unsubscribe();
        resolve();
      };
      signal.addEventListener('abort', stop, { once: true });
      process.once('SIGINT', stop);

      sub.current = vault.watch(
        (event: WatchEvent) => {
          count += 1;
          if (ctx.flags.json) {
            // The raw indexer row is attacker-influenceable, so it is flagged
            // as untrusted rather than presented as fact.
            ctx.io.out(
              JSON.stringify({
                schema: 1,
                type: 'event',
                topic: event.topic,
                event: event.type,
                vault: address,
                row: jsonSafe(event.row),
                untrusted: ['/row'],
              }),
            );
          } else {
            ctx.io.out(
              `${new Date().toISOString().slice(11, 19)}  ${safeText(event.topic, 32).padEnd(16)} ${safeText(event.type, 40)}`,
            );
          }
        },
        {
          ...(topics ? { topics: topics as WatchTopic[] } : {}),
          onStatus: (status: string, err?: Error) => {
            if (ctx.flags.json) return;
            const tone = status === 'SUBSCRIBED' ? 'ok' : 'warn';
            ctx.io.err(
              `  ${ctx.io.paint(span(status, tone))}${err ? ` — ${safeText(err.message, 120)}` : ''}`,
            );
          },
        },
      );
    });

    return { data: { events: count }, changed: false };
  },

  render(result, io) {
    io.err(`  ${result.data.events} event(s) seen.`);
  },
  toJson: (r) => ({ events: r.data.events }),
  outputSchema: {
    type: 'object',
    description:
      'While running, each event is emitted as its own JSON line: {schema,type,topic,event,vault,row,untrusted}. This object is the final summary.',
    properties: { events: { type: 'integer' } },
  },
};
