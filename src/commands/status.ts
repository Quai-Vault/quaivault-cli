import type { IndexerHealth } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { span } from '../format/tone.js';
import { formatDuration, SECONDS_PER_BLOCK } from '../format/index.js';

interface StatusData {
  network: string;
  profile: string;
  indexer: IndexerHealth;
  clockOffsetSeconds: number;
  clockSkewDetected: boolean;
}

export const statusCommand: CommandSpec<Record<string, never>, StatusData> = {
  path: ['status'],
  describe: 'Show network, indexer health and clock state',
  needs: { indexer: 'preferred' },

  async run(ctx) {
    const indexer = await ctx.qv.indexerHealth();
    return {
      data: {
        network: ctx.profile.network,
        profile: ctx.profileName,
        indexer,
        clockOffsetSeconds: ctx.skew.offsetSeconds,
        clockSkewDetected: ctx.skew.detected,
      },
      changed: false,
    };
  },

  render(result, io) {
    const d = result.data;
    io.out(`network    ${d.network}  (profile ${d.profile})`);
    if (!d.indexer.available) {
      io.out(`indexer    ${io.paint(span('unavailable', 'danger'))}`);
      io.err('');
      io.err('  Reads will fall back to the chain. Listings may be incomplete —');
      io.err('  "no results" and "cannot see results" are different things.');
      return;
    }
    const behind = d.indexer.blocksBehind ?? 0;
    const lagTone = behind > 50 ? 'warn' : 'ok';
    const lagText =
      behind === 0 ? 'live' : `${behind} blocks behind (~${formatDuration(behind * SECONDS_PER_BLOCK)})`;
    io.out(`indexer    ${io.paint(span(lagText, lagTone))}`);
    io.out(`           indexed ${d.indexer.lastIndexedBlock ?? '?'}  head ${d.indexer.chainHead ?? '?'}`);
    if (d.indexer.isSyncing) io.out(`           ${io.paint(span('syncing', 'warn'))}`);
  },

  toJson(result) {
    const d = result.data;
    return {
      network: d.network,
      profile: d.profile,
      indexer: {
        available: d.indexer.available,
        lastIndexedBlock: d.indexer.lastIndexedBlock ?? null,
        chainHead: d.indexer.chainHead ?? null,
        blocksBehind: d.indexer.blocksBehind ?? null,
        isSyncing: d.indexer.isSyncing ?? null,
      },
      clock: { offsetSeconds: d.clockOffsetSeconds, skewDetected: d.clockSkewDetected },
    };
  },

  outputSchema: {
    type: 'object',
    properties: {
      network: { type: 'string' },
      profile: { type: 'string' },
      indexer: {
        type: 'object',
        properties: {
          available: { type: 'boolean' },
          lastIndexedBlock: { type: ['integer', 'null'] },
          chainHead: { type: ['integer', 'null'] },
          blocksBehind: { type: ['integer', 'null'] },
          isSyncing: { type: ['boolean', 'null'] },
        },
      },
      clock: {
        type: 'object',
        properties: {
          offsetSeconds: { type: 'integer' },
          skewDetected: { type: 'boolean' },
        },
      },
    },
  },
};
