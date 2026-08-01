import type { VaultBalances } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { span } from '../format/tone.js';
import { formatQuai, formatUnits, safeText } from '../format/index.js';

interface BalanceData {
  address: string;
  balances: VaultBalances;
  showNfts: boolean;
}

export const balanceCommand: CommandSpec<
  { vault?: string; nfts?: boolean; verify?: boolean },
  BalanceData
> = {
  path: ['balance'],
  describe: 'Native and token balances held by a vault',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  options: [
    { flags: '--nfts', description: 'include ERC-721 and ERC-1155 holdings', defaultValue: false },
    { flags: '--no-verify', description: 'skip on-chain verification of indexed amounts' },
  ],
  needs: { indexer: 'required' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const balances = await ctx.qv
      .vault(address)
      .balances({ verify: input.verify !== false });
    return {
      data: { address, balances, showNfts: input.nfts === true },
      changed: false,
      // Token symbol and name are chosen by whoever deployed the contract.
      untrusted: balances.tokens.map((_t, i) => `/tokens/${i}/symbol`),
      warnings: balances.truncated
        ? [
            `Scan truncated (${[
              balances.truncated.transfers ? 'transfer history' : null,
              balances.truncated.tokens ? 'token count' : null,
            ]
              .filter(Boolean)
              .join(', ')}) — some holdings may be missing.`,
          ]
        : undefined,
    };
  },

  render(result, io) {
    const { balances, showNfts } = result.data;
    io.out(`  ${formatQuai(balances.native)} QUAI`);
    const erc20 = balances.tokens.filter((t) => t.standard === 'ERC20');
    const nfts = balances.tokens.filter((t) => t.standard !== 'ERC20');

    if (erc20.length) {
      io.out('');
      io.out('  Tokens');
      for (const t of erc20) {
        io.out(
          `    ${formatUnits(t.balance, t.decimals).padStart(24)}  ${io.paint(span(safeText(t.symbol, 32), 'untrusted'))}   ${io.paint(span(t.token, 'muted'))}`,
        );
      }
    }
    if (showNfts && nfts.length) {
      io.out('');
      io.out('  NFTs');
      for (const t of nfts) {
        const ids = t.tokenIds?.length
          ? ` #${t.tokenIds.slice(0, 6).join(', #')}${t.tokenIds.length > 6 ? ' …' : ''}`
          : '';
        io.out(
          `    ${String(t.balance).padStart(6)}  ${io.paint(span(safeText(t.symbol, 32), 'untrusted'))} (${t.standard})${ids}`,
        );
      }
    } else if (!showNfts && nfts.length) {
      io.err('');
      io.err(`  ${nfts.length} NFT collection${nfts.length === 1 ? '' : 's'} hidden — qv balance --nfts`);
    }
    if (!erc20.length && !nfts.length) {
      io.out('');
      io.out('  No token holdings.');
    }
  },

  toJson(result) {
    const b = result.data.balances;
    return {
      address: result.data.address,
      native: b.native.toString(10),
      truncated: b.truncated ?? null,
      tokens: b.tokens.map((t) => ({
        token: t.token,
        standard: t.standard,
        symbol: t.symbol,
        name: t.name,
        decimals: t.decimals,
        verified: t.verified,
        balance: t.balance.toString(10),
        tokenIds: t.tokenIds ?? null,
      })),
    };
  },

  outputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string' },
      native: { type: 'string', description: 'wei, decimal string' },
      tokens: {
        type: 'array',
        description: 'symbol and name are attacker-chosen; see the untrusted pointer list',
      },
    },
  },
};

export const messagesCommand: CommandSpec<
  { vault?: string },
  { address: string; messages: unknown[] }
> = {
  path: ['messages'],
  describe: 'EIP-1271 messages this vault has signed',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  needs: { indexer: 'required' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const messages = await ctx.qv.vault(address).signedMessages();
    return { data: { address, messages: messages }, changed: false };
  },

  render(result, io) {
    const msgs = result.data.messages as { hash?: string; active?: boolean }[];
    if (!msgs.length) {
      io.out('  No signed messages.');
      return;
    }
    for (const m of msgs) {
      io.out(`  ${m.active === false ? '[revoked]' : '[signed] '} ${m.hash ?? '(unknown hash)'}`);
    }
  },
  toJson: (r) => ({ address: r.data.address, messages: r.data.messages }) as never,
  outputSchema: {
    type: 'object',
    properties: { address: { type: 'string' }, messages: { type: 'array' } },
  },
};
