import { readFileSync } from 'node:fs';
import { inspectAddress, MAX_EXECUTION_DELAY, MAX_OWNERS } from '@quaivault/sdk';
import type { CreateVaultParams } from '@quaivault/sdk';
import type { CommandSpec } from '../cli/spec.js';
import { UsageError, type AppContext } from '../context/context.js';
import { writeFileAtomic } from '../context/config.js';
import { span } from '../format/tone.js';
import { formatDuration } from '../format/index.js';
import { parseDuration } from './propose.js';

interface CreateInput {
  owner?: string[];
  threshold?: string;
  minDelay?: string;
  saltFile?: string;
  from?: string;
}

interface CreatePlan {
  params: CreateVaultParams;
  salt?: string;
}

function assertOwner(address: string): string {
  const c = inspectAddress(address);
  if (!c.valid) {
    throw new UsageError(
      `Not a usable Quai address for an owner: ${address}`,
      `zone ${c.zone ?? '?'} · ledger ${c.ledger ?? '?'} — ${c.reason ?? 'invalid'}. ` +
        'QuaiVault is on the Quai ledger (EVM). A Qi address executes no contracts, so it '
        + 'can never sign — and enough Qi owners brick the vault permanently.',
    );
  }
  return address;
}

/**
 * A mined salt is only valid for the *exact* create params it was mined with —
 * including `initialModules` and `initialDelegatecallTargets`. Mining with
 * different params predicts a different address, and on a sharded network a
 * wrong address means an unreachable vault.
 *
 * So the salt file carries the params, and `--salt-file` refuses to use one
 * whose params do not match. A bare salt string is a footgun.
 */
interface SaltFile {
  salt: string;
  params: CreateVaultParams;
  predicted: string;
  minedAt: string;
}

function sameParams(a: CreateVaultParams, b: CreateVaultParams): boolean {
  const norm = (p: CreateVaultParams): string =>
    JSON.stringify({
      owners: [...p.owners].map((o) => o.toLowerCase()).sort(),
      threshold: p.threshold,
      minExecutionDelay: p.minExecutionDelay ?? 0,
      initialModules: [...(p.initialModules ?? [])].map((m) => m.toLowerCase()).sort(),
      initialDelegatecallTargets: [...(p.initialDelegatecallTargets ?? [])]
        .map((t) => t.toLowerCase())
        .sort(),
    });
  return norm(a) === norm(b);
}

function collectParams(ctx: AppContext, input: CreateInput): CreateVaultParams {
  if (input.from) {
    const raw = JSON.parse(readFileSync(input.from, 'utf8')) as CreateVaultParams;
    if (!Array.isArray(raw.owners) || typeof raw.threshold !== 'number') {
      throw new UsageError(`${input.from} does not describe a vault (need owners and threshold).`);
    }
    raw.owners.forEach(assertOwner);
    return raw;
  }
  const owners = (Array.isArray(input.owner) ? input.owner : input.owner ? [input.owner] : []).map(
    assertOwner,
  );
  if (!owners.length) {
    throw new UsageError('At least one --owner is required.', 'Or describe the vault with --from vault.json.');
  }
  if (owners.length > MAX_OWNERS) {
    throw new UsageError(`A vault may have at most ${MAX_OWNERS} owners.`);
  }
  const unique = new Set(owners.map((o) => o.toLowerCase()));
  if (unique.size !== owners.length) throw new UsageError('Duplicate owner addresses.');

  const threshold = Number(input.threshold ?? owners.length);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new UsageError(`--threshold must be between 1 and ${owners.length}.`);
  }
  const minExecutionDelay = input.minDelay ? parseDuration(input.minDelay) : 0;
  if (minExecutionDelay > MAX_EXECUTION_DELAY) {
    throw new UsageError(
      `Minimum delay exceeds the contract maximum of ${formatDuration(MAX_EXECUTION_DELAY)}.`,
    );
  }
  void ctx;
  return { owners, threshold, minExecutionDelay };
}

export const vaultCreateCommand: CommandSpec<CreateInput, { address: string; salt: string }, CreatePlan> = {
  path: ['vault', 'create'],
  describe: 'Deploy a new vault',
  options: [
    { flags: '--owner <address...>', description: 'owner address (repeat for each)' },
    { flags: '--threshold <n>', description: 'approvals required (default: all owners)' },
    { flags: '--min-delay <duration>', description: 'vault minimum timelock, e.g. 24h' },
    { flags: '--salt-file <path>', description: 'use a salt mined earlier by `qv vault mine-salt`' },
    { flags: '--from <path>', description: 'read the vault definition from a JSON file' },
  ],
  needs: { signer: true },

  plan(ctx, input) {
    const params = collectParams(ctx, input);
    let salt: string | undefined;
    if (input.saltFile) {
      const file = JSON.parse(readFileSync(input.saltFile, 'utf8')) as SaltFile;
      if (!sameParams(file.params, params)) {
        throw new UsageError(
          'That salt was mined for different create parameters.',
          'The predicted address is a function of the params, so reusing the salt would deploy ' +
            'to a different — and possibly unreachable — address. Re-mine, or fix the parameters.',
        );
      }
      salt = file.salt;
    }
    return Promise.resolve({
      disclosure: { params, salt },
      summary: `deploy a ${params.threshold}-of-${params.owners.length} vault`,
    });
  },

  renderPlan(planned, io) {
    const p = planned.disclosure.params;
    io.out('');
    io.out(io.paint(span('About to deploy a new vault', 'accent')));
    io.out(`  Threshold  ${p.threshold} of ${p.owners.length}`);
    for (const o of p.owners) io.out(`    ${o}`);
    io.out(`  Timelock   ${formatDuration(p.minExecutionDelay ?? 0)}`);
    if (planned.disclosure.salt) io.out(`  Salt       ${planned.disclosure.salt} (pre-mined)`);
  },

  async commit(ctx, planned) {
    await ctx.requireSigner();
    const result = await ctx.qv.factory.create(
      { ...planned.disclosure.params, ...(planned.disclosure.salt ? { salt: planned.disclosure.salt } : {}) },
      {
        onProgress: (p: { step: string; message: string }) => {
          if (!ctx.flags.json && !ctx.flags.quiet) ctx.io.err(`  ${p.step}: ${p.message}`);
        },
      },
    );
    return {
      data: { address: result.address, salt: result.salt },
      changed: true,
      steps: [{ name: 'deploy', status: 'ok' }],
      next: [`qv vault show ${result.address}`],
      warnings: result.predictionMatched === false
        ? ['The deployed address did not match the prediction. Verify before funding it.']
        : undefined,
    };
  },

  render(result, io) {
    io.out('');
    io.out(io.paint(span('  DEPLOYED', 'ok')));
    io.out(`  ${result.data.address}`);
    io.err('');
    io.err(`  qv alias add <name> ${result.data.address}`);
  },
  toJson: (r) => ({ address: r.data.address, salt: r.data.salt }),
  outputSchema: {
    type: 'object',
    properties: { address: { type: 'string' }, salt: { type: 'string' } },
  },
};

export const mineSaltCommand: CommandSpec<
  CreateInput & { out?: string },
  { salt: string; predicted: string; file?: string }
> = {
  path: ['vault', 'mine-salt'],
  describe: 'Mine a CREATE2 salt offline, ahead of deploying',
  options: [
    { flags: '--owner <address...>', description: 'owner address (repeat for each)' },
    { flags: '--threshold <n>', description: 'approvals required' },
    { flags: '--min-delay <duration>', description: 'vault minimum timelock' },
    { flags: '--from <path>', description: 'read the vault definition from a JSON file' },
    { flags: '--out <path>', description: 'write the salt and its parameters to this file' },
  ],
  needs: { identity: true },

  async run(ctx, input, signal) {
    const params = collectParams(ctx, input);
    // Mining is offline and keyless, but the mined address lands on the
    // *deployer's* shard — so the identity is required, and it must be the
    // address that will actually call createWallet.
    const deployer = ctx.identity();
    if (!deployer) {
      throw new UsageError(
        'Mining needs to know who will deploy: the salt places the vault on their shard.',
        'Pass --as 0x…, or set one with `qv use --as`.',
      );
    }
    const mined = await ctx.qv.factory.mineSalt(params, {
      deployer,
      signal,
      onProgress: (attempts: number) => {
        if (!ctx.flags.json && !ctx.flags.quiet && attempts % 50_000 === 0) {
          ctx.io.err(`  mining… ${attempts.toLocaleString()} attempts`);
        }
      },
    });
    const record: SaltFile = {
      salt: mined.salt,
      params,
      predicted: mined.predictedAddress,
      minedAt: new Date(ctx.now() * 1000).toISOString(),
    };
    let file: string | undefined;
    if (input.out) {
      // The params travel with the salt so `--salt-file` can refuse a mismatch.
      writeFileAtomic(input.out, `${JSON.stringify(record, null, 2)}\n`, 0o600);
      file = input.out;
    }
    return { data: { salt: mined.salt, predicted: mined.predictedAddress, file }, changed: Boolean(file) };
  },

  render(result, io) {
    io.out(`  salt       ${result.data.salt}`);
    io.out(`  predicted  ${result.data.predicted}`);
    if (result.data.file) {
      io.err('');
      io.err(`  Saved to ${result.data.file} — deploy with:`);
      io.err(`    qv vault create --salt-file ${result.data.file} …same parameters…`);
    } else {
      io.err('');
      io.err('  Pass --out to save the salt with its parameters. A bare salt is a footgun:');
      io.err('  reusing it with different parameters predicts a different, unreachable address.');
    }
  },
  toJson: (r) => ({ salt: r.data.salt, predicted: r.data.predicted, file: r.data.file ?? null }),
  outputSchema: {
    type: 'object',
    properties: {
      salt: { type: 'string' },
      predicted: { type: 'string' },
      file: { type: ['string', 'null'] },
    },
  },
};
