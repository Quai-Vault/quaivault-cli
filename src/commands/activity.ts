import type { CommandSpec } from '../cli/spec.js';
import { cacheKey } from '../store/index.js';

interface ActivityData {
  vault: string;
  data: Record<string, unknown>[];
  total: number;
  hasMore: boolean;
}

function activityCommand(kind: 'deposits' | 'token-transfers'): CommandSpec<
  { vault?: string; limit?: string; offset?: string },
  ActivityData
> {
  return {
    path: ['activity', kind],
    describe: kind === 'deposits' ? 'Native QUAI deposits received by a vault' : 'ERC-20/721/1155 transfers involving a vault',
    args: [{ name: 'vault', description: 'vault alias or address' }],
    options: [
      { flags: '--limit <n>', description: 'maximum rows', defaultValue: '50' },
      { flags: '--offset <n>', description: 'rows to skip', defaultValue: '0' },
    ],
    needs: { indexer: 'required' },
    key: (input) => cacheKey(['activity', kind], input.vault, input.limit, input.offset),
    invalidatedBy: kind === 'deposits' ? ['deposits'] : ['tokenTransfers'],
    scopeVault: (input) => input.vault,
    async run(ctx, input) {
      const vault = ctx.resolveVault(input.vault);
      const paging = { limit: Number(input.limit ?? 50), offset: Number(input.offset ?? 0) };
      const handle = ctx.qv.vault(vault);
      const page = kind === 'deposits'
        ? await handle.deposits(paging)
        : await handle.tokenTransfers(paging);
      return {
        data: {
          vault,
          data: page.data,
          total: page.total,
          hasMore: page.hasMore,
        },
        changed: false,
        retryable: false,
      };
    },
    render(result, io) {
      if (!result.data.data.length) {
        io.out(`  No ${kind}.`);
        return;
      }
      for (const row of result.data.data) {
        if (kind === 'deposits') {
          io.out(`  ${field(row, 'deposited_at_block', '?').padStart(10)}  ${field(row, 'sender_address', '?')}  ${field(row, 'amount', '0')} wei`);
        } else {
          io.out(`  ${field(row, 'block_number', '?').padStart(10)}  ${field(row, 'direction', '?').padEnd(7)} ${field(row, 'token_address', '?')}  ${field(row, 'value', '0')}`);
        }
      }
    },
    toJson: (result) => ({
      vault: result.data.vault,
      data: result.data.data,
      total: result.data.total,
      hasMore: result.data.hasMore,
    }) as never,
    outputSchema: {
      type: 'object',
      required: ['vault', 'data', 'total', 'hasMore'],
      properties: {
        vault: { type: 'string' },
        data: { type: 'array' },
        total: { type: 'integer' },
        hasMore: { type: 'boolean' },
      },
    },
  };
}

function field(row: Record<string, unknown>, key: string, fallback: string): string {
  const value = row[key];
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint'
    ? value.toString()
    : fallback;
}

export const depositHistoryCommand = activityCommand('deposits');
export const tokenTransferHistoryCommand = activityCommand('token-transfers');

export const ACTIVITY_COMMANDS = [depositHistoryCommand, tokenTransferHistoryCommand] as CommandSpec[];
