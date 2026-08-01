import type { VaultInfo, VaultTransaction } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { cacheKey } from '../store/index.js';
import { UsageError } from '../context/context.js';
import { span } from '../format/tone.js';
import { formatDuration, formatQuai, safeText } from '../format/index.js';
import { txRow, txToJson } from '../render/transaction.js';
import { recoveryAlarm, type RecoveryAlarm } from '../render/recovery-alarm.js';

interface VaultShowData {
  info: VaultInfo;
  pending: VaultTransaction[];
  chainHead?: number;
  alarm: RecoveryAlarm | null;
  isOwner: boolean;
  identity?: string;
}

export const vaultShowCommand: CommandSpec<{ vault?: string }, VaultShowData> = {
  path: ['vault', 'show'],
  key: (input) => cacheKey(['vault', 'show'], input.vault),
  invalidatedBy: ['owners', 'modules', 'transactions', 'confirmations'],
  scopeVault: (input) => input.vault,
  describe: 'Vault owners, threshold, balance, timelock and pending transactions',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  needs: { indexer: 'preferred' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const vault = ctx.qv.vault(address);
    const [info, pending, health, alarm] = await Promise.all([
      vault.info(),
      vault.pendingTransactions().catch(() => [] as VaultTransaction[]),
      ctx.qv.indexerHealth().catch(() => null),
      recoveryAlarm(ctx, address),
    ]);
    const identity = ctx.identity();
    return {
      data: {
        info,
        pending,
        chainHead: health?.chainHead,
        alarm,
        isOwner: identity ? info.owners.some((o) => o.toLowerCase() === identity.toLowerCase()) : false,
        identity,
      },
      changed: false,
      next: pending.length
        ? [`qv tx show ${address} ${pending[0]!.hash.slice(0, 10)}`]
        : undefined,
    };
  },

  render(result, io, ctx) {
    const { info, pending, alarm } = result.data;
    const alias = Object.entries(ctx.config.aliases).find(
      ([, v]) => v.toLowerCase() === info.address.toLowerCase(),
    )?.[0];

    if (alarm) alarm.render(io);

    io.out(`${alias ? `${alias}    ` : ''}${info.address}`);
    io.out(
      `${' '.repeat(alias ? alias.length + 4 : 0)}${ctx.profile.network}${result.data.isOwner ? ' · you are an owner' : ''}`,
    );
    io.out('');
    io.out(`  Threshold      ${info.threshold} of ${info.owners.length} owners`);
    io.out(`  Balance        ${formatQuai(info.balance)} QUAI`);
    io.out(
      `  Timelock       ${info.minExecutionDelay > 0 ? `${formatDuration(info.minExecutionDelay)} minimum delay` : 'none (simple quorum)'}`,
    );
    io.out(`  Modules        ${info.moduleCount}`);
    io.out('');
    io.out('  Owners');
    for (const owner of info.owners) {
      const name = ctx.contactName(owner);
      const isYou =
        result.data.identity && owner.toLowerCase() === result.data.identity.toLowerCase();
      io.out(
        `    ${owner}${name ? `   ${safeText(name, 40)}` : ''}${isYou ? io.paint(span('   you', 'accent')) : ''}`,
      );
    }

    io.out('');
    if (pending.length === 0) {
      io.out('  No pending transactions.');
    } else {
      io.out(`  Pending (${pending.length})`);
      io.out(io.paint(span('    HASH      AGE          APPR   STATE              SUMMARY', 'muted')));
      for (const tx of pending) io.out(txRow(tx, io, ctx, result.data.chainHead));
    }
  },

  toJson(result) {
    const { info, pending, chainHead, alarm } = result.data;
    return {
      address: info.address,
      owners: info.owners,
      threshold: info.threshold,
      minExecutionDelay: info.minExecutionDelay,
      nonce: info.nonce,
      balance: info.balance.toString(10),
      moduleCount: info.moduleCount,
      isOwner: result.data.isOwner,
      pendingRecovery: alarm ? alarm.toJson() : null,
      pending: pending.map((t) => txToJson(t, chainHead)),
    } as never;
  },

  outputSchema: {
    type: 'object',
    properties: {
      address: { type: 'string' },
      owners: { type: 'array', items: { type: 'string' } },
      threshold: { type: 'integer' },
      minExecutionDelay: { type: 'integer', description: 'seconds' },
      balance: { type: 'string', description: 'wei, decimal string' },
      isOwner: { type: 'boolean' },
      pendingRecovery: { type: ['object', 'null'] },
      pending: { type: 'array', items: { $ref: '#/definitions/transaction' } },
    },
  },
};

interface VaultLsData {
  owned: string[];
  guardian: string[];
  identity: string;
}

export const vaultLsCommand: CommandSpec<{ role?: string }, VaultLsData> = {
  path: ['vault', 'ls'],
  key: () => cacheKey(['vault', 'ls']),
  invalidatedBy: ['owners'],
  describe: 'Vaults you own or guard',
  options: [
    { flags: '--role <role>', description: 'filter by role', choices: ['owner', 'guardian'] },
  ],
  needs: { identity: true, indexer: 'required' },

  async run(ctx, input) {
    const identity = ctx.identity();
    if (!identity) throw new UsageError('No identity set.');
    const role = input.role;
    const [owned, guardian] = await Promise.all([
      role === 'guardian' ? Promise.resolve([]) : ctx.qv.vaults.forOwner(identity),
      role === 'owner' ? Promise.resolve([]) : ctx.qv.vaults.forGuardian(identity),
    ]);
    return { data: { owned, guardian, identity }, changed: false };
  },

  render(result, io, ctx) {
    const { owned, guardian, identity } = result.data;
    const dual = new Set(owned.map((a) => a.toLowerCase()));
    const guardianOnly = guardian.filter((a) => !dual.has(a.toLowerCase()));
    io.out(`acting as ${identity}`);
    io.out('');
    if (!owned.length && !guardianOnly.length) {
      io.out('  No vaults found for this address.');
      return;
    }
    const label = (a: string): string => {
      const alias = Object.entries(ctx.config.aliases).find(
        ([, v]) => v.toLowerCase() === a.toLowerCase(),
      )?.[0];
      return alias ? `${a}  (${alias})` : a;
    };
    if (owned.length) {
      io.out(`  Your vaults (${owned.length})`);
      for (const a of owned) {
        const alsoGuardian = guardian.some((g) => g.toLowerCase() === a.toLowerCase());
        io.out(`    ${label(a)}${alsoGuardian ? io.paint(span('   owner+guardian', 'muted')) : ''}`);
      }
    }
    if (guardianOnly.length) {
      if (owned.length) io.out('');
      io.out(`  Vaults you guard (${guardianOnly.length})`);
      for (const a of guardianOnly) io.out(`    ${label(a)}`);
    }
  },

  toJson(result) {
    const dual = new Set(result.data.owned.map((a) => a.toLowerCase()));
    return {
      identity: result.data.identity,
      owned: result.data.owned,
      guardian: result.data.guardian,
      guardianOnly: result.data.guardian.filter((a) => !dual.has(a.toLowerCase())),
    };
  },

  outputSchema: {
    type: 'object',
    properties: {
      identity: { type: 'string' },
      owned: { type: 'array', items: { type: 'string' } },
      guardian: { type: 'array', items: { type: 'string' } },
      guardianOnly: { type: 'array', items: { type: 'string' } },
    },
  },
};

export const vaultReceiveCommand: CommandSpec<{ vault?: string }, { address: string }> = {
  path: ['vault', 'receive'],
  describe: 'Show the vault address for receiving funds',
  args: [{ name: 'vault', description: 'vault alias or address' }],

  run(ctx, input) {
    return Promise.resolve({ data: { address: ctx.resolveVault(input.vault) }, changed: false });
  },
  render(result, io) {
    io.out(result.data.address);
    io.err('');
    io.err('  This is a Quai-ledger (EVM) address. Qi is a separate UTXO ledger that');
    io.err('  executes no contracts — do not send Qi here.');
  },
  toJson: (r) => ({ address: r.data.address }),
  outputSchema: { type: 'object', properties: { address: { type: 'string' } } },
};
