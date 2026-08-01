import type { RecoveryRequest, RecoveryConfig } from '@quaivault/sdk';
import type { CommandSpec, WritePlan } from '../cli/spec.js';
import { PreconditionError, UsageError, type AppContext } from '../context/context.js';
import { promptTyped } from '../cli/confirm.js';
import { span } from '../format/tone.js';
import { formatAbsolute, formatDuration, safeText } from '../format/index.js';
import type { Io } from '../render/io.js';

/**
 * Recovery friction is deliberately the inverse of the pattern in Appendix A.
 *
 * `execute` replaces the **entire owner set and threshold** — it takes a typed
 * confirmation. `cancel` is the owners' defence against a hostile or mistaken
 * guardian action — it takes nothing at all. Getting this backwards is the
 * specific mistake being corrected.
 */

interface RecoveryStatusData {
  address: string;
  config: RecoveryConfig | null;
  pending: RecoveryRequest[];
  enabled: boolean;
}

export const recoveryStatusCommand: CommandSpec<{ vault?: string }, RecoveryStatusData> = {
  path: ['recovery', 'status'],
  describe: 'Guardian configuration and any pending recovery',
  args: [{ name: 'vault', description: 'vault alias or address' }],

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const recovery = ctx.qv.vault(address).recovery;
    const enabled = await recovery.isEnabled().catch(() => false);
    const [config, pending] = await Promise.all([
      enabled ? recovery.config().catch(() => null) : Promise.resolve(null),
      enabled ? recovery.pending().catch(() => []) : Promise.resolve([]),
    ]);
    return { data: { address, config, pending, enabled }, changed: false };
  },

  render(result, io, ctx) {
    const { config, pending, enabled } = result.data;
    if (!enabled) {
      io.out('  Social recovery is not enabled on this vault.');
      return;
    }
    if (config) {
      io.out(`  Guardians    ${config.threshold} of ${config.guardians.length}`);
      for (const g of config.guardians) {
        const name = ctx.contactName(g);
        io.out(`    ${g}${name ? `   ${safeText(name, 40)}` : ''}`);
      }
      io.out(`  Period       ${formatDuration(config.recoveryPeriod)}`);
    }
    if (!pending.length) {
      io.out('');
      io.out('  No pending recovery.');
      return;
    }
    for (const r of pending) {
      io.out('');
      io.out(io.paint(span('  PENDING RECOVERY', 'danger')));
      io.out(`    hash        ${r.hash}`);
      io.out(`    approvals   ${r.approvalCount} of ${r.requiredThreshold}`);
      io.out(`    new owners  ${r.newThreshold} of ${r.newOwners.length}`);
      for (const o of r.newOwners) io.out(`      ${o}`);
      const left = r.executionTime - ctx.now();
      io.out(
        `    executable  ${left > 0 ? `in ${formatDuration(left)} (${formatAbsolute(r.executionTime)})` : io.paint(span('NOW', 'danger'))}`,
      );
      io.out('');
      io.out(io.paint(span(`    Any current owner can stop this:`, 'danger')));
      io.out(io.paint(span(`      qv recovery cancel ${result.data.address} ${r.hash}`, 'danger')));
    }
  },

  toJson: (r) => ({
    vault: r.data.address,
    enabled: r.data.enabled,
    config: r.data.config
      ? {
          guardians: r.data.config.guardians,
          threshold: r.data.config.threshold,
          recoveryPeriod: r.data.config.recoveryPeriod,
        }
      : null,
    pending: r.data.pending.map((p) => ({
      hash: p.hash,
      newOwners: p.newOwners,
      newThreshold: p.newThreshold,
      approvalCount: p.approvalCount,
      requiredThreshold: p.requiredThreshold,
      executionTime: p.executionTime,
      expiration: p.expiration,
      status: p.status,
    })),
  }),

  outputSchema: {
    type: 'object',
    properties: {
      vault: { type: 'string' },
      enabled: { type: 'boolean' },
      config: { type: ['object', 'null'] },
      pending: { type: 'array' },
    },
  },
};

export const recoveryHistoryCommand: CommandSpec<
  { vault?: string },
  { address: string; history: RecoveryRequest[]; degraded: boolean }
> = {
  path: ['recovery', 'history'],
  describe: 'Past recoveries on this vault',
  args: [{ name: 'vault', description: 'vault alias or address' }],
  needs: { indexer: 'required' },

  async run(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    try {
      const history = await ctx.qv.vault(address).recovery.history();
      return { data: { address, history, degraded: false }, changed: false };
    } catch (err) {
      // `history()` throws NoIndexerError rather than returning [] — the
      // correct signal, but it must not propagate as a crash.
      if ((err as { code?: string }).code === 'NO_INDEXER') {
        return { data: { address, history: [], degraded: true }, changed: false };
      }
      throw err;
    }
  },

  render(result, io) {
    if (result.data.degraded) {
      io.out('  Cannot see recovery history (indexer unavailable).');
      return;
    }
    if (!result.data.history.length) {
      io.out('  No recoveries on record.');
      return;
    }
    for (const r of result.data.history) {
      io.out(`  ${r.hash.slice(2, 10)}  ${r.status.padEnd(10)} ${r.newThreshold} of ${r.newOwners.length}`);
    }
  },
  toJson: (r) => ({
    vault: r.data.address,
    degraded: r.data.degraded,
    history: r.data.history.map((h) => ({ hash: h.hash, status: h.status })),
  }),
  outputSchema: {
    type: 'object',
    properties: { vault: { type: 'string' }, degraded: { type: 'boolean' }, history: { type: 'array' } },
  },
};

// ------------------------------------------------------------------- writes

interface RecoveryWriteInput {
  vault?: string;
  hash: string;
}

interface RecoveryDisclosure {
  address: string;
  request: RecoveryRequest | null;
  action: string;
}

async function planRecovery(
  ctx: AppContext,
  input: RecoveryWriteInput,
  action: string,
): Promise<WritePlan<RecoveryDisclosure>> {
  const address = ctx.resolveVault(input.vault);
  const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
  const request = await ctx.qv.vault(address).recovery.get(hash).catch(() => null);
  return {
    disclosure: { address, request, action },
    summary: `${action} recovery ${hash.slice(0, 10)}`,
  };
}

function renderRecoveryPlan(
  planned: WritePlan<RecoveryDisclosure>,
  io: Io,
  ctx: AppContext,
): void {
  const r = planned.disclosure.request;
  io.out('');
  io.out(io.paint(span(`About to ${planned.disclosure.action} a recovery`, 'accent')));
  if (!r) {
    io.out('  (could not read the recovery record)');
    return;
  }
  io.out(`  hash        ${r.hash}`);
  io.out(`  approvals   ${r.approvalCount} of ${r.requiredThreshold}`);
  io.out('');
  io.out(io.paint(span('  This REPLACES the entire owner set with:', 'danger')));
  for (const o of r.newOwners) io.out(io.paint(span(`    ${o}`, 'danger')));
  io.out(io.paint(span(`  New threshold: ${r.newThreshold} of ${r.newOwners.length}`, 'danger')));
  void ctx;
}

export const recoveryApproveCommand: CommandSpec<RecoveryWriteInput, { hash: string }, RecoveryDisclosure> = {
  path: ['recovery', 'approve'],
  describe: 'Approve a pending recovery (guardians only)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  needs: { signer: true },
  plan: (ctx, input) => planRecovery(ctx, input, 'approve'),
  renderPlan: renderRecoveryPlan,
  async commit(ctx, planned, input) {
    await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    await ctx.qv.vault(planned.disclosure.address).recovery.approve(hash);
    return { data: { hash }, changed: true };
  },
  render: (r, io) => io.out(`  recovery approved   ${r.data.hash}`),
  toJson: (r) => ({ hash: r.data.hash }),
  outputSchema: { type: 'object', properties: { hash: { type: 'string' } } },
};

export const recoveryExecuteCommand: CommandSpec<RecoveryWriteInput, { hash: string }, RecoveryDisclosure> = {
  path: ['recovery', 'execute'],
  describe: 'Execute a recovery — replaces every owner',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  needs: { signer: true },
  plan: (ctx, input) => planRecovery(ctx, input, 'EXECUTE'),
  renderPlan: renderRecoveryPlan,

  async commit(ctx, planned, input) {
    const alias =
      Object.entries(ctx.config.aliases).find(
        ([, v]) => v.toLowerCase() === planned.disclosure.address.toLowerCase(),
      )?.[0] ?? planned.disclosure.address;

    // The highest-consequence command in the product. A typed confirmation,
    // never a bare y/N — and --yes does not skip it.
    if (ctx.interactive) {
      ctx.io.err('');
      ctx.io.err('This replaces every owner of the vault. It cannot be undone.');
      const ok = await promptTyped(`Type the vault name (${alias}) to confirm: `, alias);
      if (!ok) throw new UsageError('Confirmation did not match. Nothing was executed.');
    } else if (!ctx.flags.yes) {
      throw new PreconditionError(
        'Executing a recovery needs confirmation and there is no terminal.',
        'This replaces every owner. Re-run at a terminal.',
      );
    }

    await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    await ctx.qv.vault(planned.disclosure.address).recovery.execute(hash);
    return { data: { hash }, changed: true };
  },
  render: (r, io) => io.out(`  recovery executed   ${r.data.hash}`),
  toJson: (r) => ({ hash: r.data.hash }),
  outputSchema: { type: 'object', properties: { hash: { type: 'string' } } },
};

export const recoveryCancelCommand: CommandSpec<RecoveryWriteInput, { hash: string }, RecoveryDisclosure> = {
  path: ['recovery', 'cancel'],
  describe: 'Cancel a pending recovery (any current owner)',
  args: [
    { name: 'vault', description: 'vault alias or address', required: true },
    { name: 'hash', description: 'recovery hash', required: true },
  ],
  needs: { signer: true },
  // Deliberately zero friction: this is the defensive action, and every second
  // of hesitation favours the attacker.
  plan: (ctx, input) => planRecovery(ctx, input, 'cancel'),
  renderPlan: renderRecoveryPlan,
  async commit(ctx, planned, input) {
    await ctx.requireSigner();
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    await ctx.qv.vault(planned.disclosure.address).recovery.cancel(hash);
    return { data: { hash }, changed: true };
  },
  render: (r, io) => io.out(`  recovery cancelled   ${r.data.hash}`),
  toJson: (r) => ({ hash: r.data.hash }),
  outputSchema: { type: 'object', properties: { hash: { type: 'string' } } },
};

export const recoveryInitiateCommand: CommandSpec<
  { vault?: string; owner: string[]; threshold: string },
  { hash: string },
  RecoveryDisclosure
> = {
  path: ['recovery', 'initiate'],
  describe: 'Initiate a recovery (guardians only)',
  args: [{ name: 'vault', description: 'vault alias or address', required: true }],
  options: [
    { flags: '--owner <address...>', description: 'new owner (repeat for each)' },
    { flags: '--threshold <n>', description: 'new threshold' },
  ],
  needs: { signer: true },

  plan(ctx, input) {
    const address = ctx.resolveVault(input.vault);
    const owners = Array.isArray(input.owner) ? input.owner : input.owner ? [input.owner] : [];
    if (!owners.length) throw new UsageError('At least one --owner is required.');
    const threshold = Number(input.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
      throw new UsageError(`--threshold must be between 1 and ${owners.length}.`);
    }
    return Promise.resolve({
      disclosure: { address, request: null, action: 'initiate' },
      summary: `initiate recovery to ${threshold} of ${owners.length}`,
    });
  },

  renderPlan(planned, io) {
    io.out('');
    io.out(io.paint(span('About to INITIATE a recovery', 'danger')));
    io.out('  This starts the clock on replacing every owner of the vault.');
  },

  async commit(ctx, planned, input) {
    await ctx.requireSigner();
    const owners = Array.isArray(input.owner) ? input.owner : [input.owner];
    const result = await ctx.qv
      .vault(planned.disclosure.address)
      .recovery.initiate({ newOwners: owners, newThreshold: Number(input.threshold) });
    return { data: { hash: (result as { hash?: string }).hash ?? '' }, changed: true };
  },
  render: (r, io) => io.out(`  recovery initiated   ${r.data.hash}`),
  toJson: (r) => ({ hash: r.data.hash }),
  outputSchema: { type: 'object', properties: { hash: { type: 'string' } } },
};

export const RECOVERY_COMMANDS = [
  recoveryStatusCommand,
  recoveryHistoryCommand,
  recoveryApproveCommand,
  recoveryExecuteCommand,
  recoveryCancelCommand,
  recoveryInitiateCommand,
] as CommandSpec[];
