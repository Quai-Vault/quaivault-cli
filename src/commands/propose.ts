import { inspectAddress, MAX_EXECUTION_DELAY } from '@quaivault/sdk';
import type { ProposeResult, DryRunResult, Vault } from '@quaivault/sdk';
import type { CommandSpec, WritePlan } from '../cli/spec.js';
import { PreconditionError, UsageError, type AppContext } from '../context/context.js';
import { span } from '../format/tone.js';
import {
  formatDuration,
  formatQuai,
  formatUnits,
  parseQuai,
  parseUnits,
} from '../format/index.js';
import type { Io } from '../render/io.js';

/**
 * Every write except approve/execute/cancel/expire is a *proposal*: it asks
 * N−1 other people to act. Naming them `qv propose <thing>` mirrors the SDK's
 * `propose.*` and makes the mental model correct by construction — `qv owner
 * add` would read like it adds an owner, when it asks two other people to.
 */

interface ProposeCommon {
  vault?: string;
  expiration?: string;
  executionDelay?: string;
}

interface ProposePlan {
  address: string;
  action: string;
  detail: string[];
  build: (vault: Vault, dryRun: boolean) => Promise<ProposeResult | DryRunResult>;
  unverified: boolean;
}

const COMMON_OPTIONS = [
  {
    flags: '--expiration <when>',
    description: 'expiry as a duration (7d, 24h) or unix seconds; default none',
  },
  {
    flags: '--execution-delay <duration>',
    description: 'extra timelock beyond the vault floor (e.g. 24h)',
  },
];

/** Accept `7d`, `24h`, `30m`, `90s`, or a bare number of seconds. */
export function parseDuration(input: string): number {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(input.trim());
  if (!m) {
    throw new UsageError(
      `Cannot read ${JSON.stringify(input)} as a duration.`,
      'Use 90s, 30m, 24h, 7d, or a plain number of seconds.',
    );
  }
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const mult = unit === 'd' ? 86_400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return n * mult;
}

function assertRecipient(address: string, role = 'recipient'): string {
  const c = inspectAddress(address);
  if (!c.valid) {
    throw new UsageError(
      `Not a usable Quai address for ${role}: ${address}`,
      `zone ${c.zone ?? '?'} · ledger ${c.ledger ?? '?'} — ${c.reason ?? 'invalid'}`,
    );
  }
  return address;
}

/**
 * Validate expiry against the *effective* delay before proposing.
 *
 * The contract rejects `expiration <= block.timestamp + effectiveDelay`, and
 * the effective delay is `max(vaultFloor, userDelay)` — **not** the sum. Get
 * this wrong and the proposal either reverts, or expires before it can ever
 * execute. Computed in exactly one place for that reason.
 */
async function resolveTiming(
  ctx: AppContext,
  vault: Vault,
  input: ProposeCommon,
): Promise<{ expiration?: number; executionDelay?: number; effectiveDelay: number }> {
  const info = await vault.info();
  const userDelay = input.executionDelay ? parseDuration(input.executionDelay) : 0;
  if (userDelay > MAX_EXECUTION_DELAY) {
    throw new UsageError(
      `Execution delay ${formatDuration(userDelay)} exceeds the contract maximum of ${formatDuration(MAX_EXECUTION_DELAY)}.`,
    );
  }
  const effectiveDelay = Math.max(info.minExecutionDelay, userDelay);

  let expiration: number | undefined;
  if (input.expiration) {
    const raw = input.expiration.trim();
    expiration = /^\d{10,}$/.test(raw) ? Number(raw) : ctx.now() + parseDuration(raw);
    const earliest = ctx.now() + effectiveDelay;
    if (expiration <= earliest) {
      throw new UsageError(
        'That expiry is before the transaction could ever execute.',
        `The effective timelock is ${formatDuration(effectiveDelay)}, so the expiry must be later than ` +
          `${new Date(earliest * 1000).toISOString()}. Leave a margin for block time.`,
      );
    }
  }
  return {
    ...(expiration !== undefined ? { expiration } : {}),
    ...(userDelay > 0 ? { executionDelay: userDelay } : {}),
    effectiveDelay,
  };
}

function isDryRun(r: ProposeResult | DryRunResult): r is DryRunResult {
  return !('chainTxHash' in r) || (r).chainTxHash === undefined;
}

interface ProposeOutcome {
  address: string;
  txHash?: string;
  chainTxHash?: string;
  to?: string;
  value?: bigint;
  data?: string;
  action: string;
}

function renderProposePlan(
  planned: WritePlan<ProposePlan>,
  io: Io,
): void {
  const d = planned.disclosure;
  io.out('');
  io.out(io.paint(span(`About to propose: ${d.action}`, 'accent')));
  for (const line of d.detail) io.out(`  ${line}`);
  io.out('');
  io.out('  Nothing moves until enough owners approve.');
}

function proposeResultRender(
  result: { data: ProposeOutcome },
  io: Io,
): void {
  const d = result.data;
  io.out('');
  io.out(io.paint(span('  PROPOSED — nothing has moved yet.', 'warn')));
  if (d.txHash) io.out(`  tx     ${d.txHash}`);
  if (d.chainTxHash) io.out(`  chain  ${d.chainTxHash}`);
  io.out('');
  io.out('  Send this to your co-owners:');
  io.out(`    qv tx show ${d.address} ${d.txHash ?? ''}`);
  io.out(`    qv tx approve ${d.address} ${d.txHash ?? ''}`);
}

const proposeSchema = {
  type: 'object',
  properties: {
    transactionHash: { type: ['string', 'null'], description: 'the vault transaction hash' },
    chainTxHash: { type: ['string', 'null'] },
    vault: { type: 'string' },
    to: { type: ['string', 'null'] },
    value: { type: ['string', 'null'], description: 'wei, decimal string' },
    data: { type: ['string', 'null'] },
  },
};

function proposeJson(r: { data: ProposeOutcome }): Record<string, unknown> {
  return {
    transactionHash: r.data.txHash ?? null,
    chainTxHash: r.data.chainTxHash ?? null,
    vault: r.data.address,
    to: r.data.to ?? null,
    value: r.data.value ?? null,
    data: r.data.data ?? null,
  };
}

/** Build a propose command from a builder, so the ~15 of them are not 15 copies. */
function makeProposeCommand<I extends ProposeCommon>(cfg: {
  path: string[];
  describe: string;
  args?: CommandSpec['args'];
  options?: CommandSpec['options'];
  action: string;
  build: (
    ctx: AppContext,
    vault: Vault,
    input: I,
    timing: { expiration?: number; executionDelay?: number },
  ) => Promise<{ detail: string[]; call: (dryRun: boolean) => Promise<ProposeResult | DryRunResult> }>;
}): CommandSpec<I, ProposeOutcome, ProposePlan> {
  return {
    path: cfg.path,
    describe: cfg.describe,
    args: [{ name: 'vault', description: 'vault alias or address', required: true }, ...(cfg.args ?? [])],
    options: [...(cfg.options ?? []), ...COMMON_OPTIONS],
    needs: { signer: true },

    async plan(ctx, input) {
      const address = ctx.resolveVault(input.vault);
      const vault = ctx.qv.vault(address);
      const timing = await resolveTiming(ctx, vault, input);
      const built = await cfg.build(ctx, vault, input, timing);
      const detail = [...built.detail];
      if (timing.effectiveDelay > 0) {
        detail.push(`Timelock: ${formatDuration(timing.effectiveDelay)} once quorum is reached`);
      }
      if (timing.expiration) {
        detail.push(`Expires: ${new Date(timing.expiration * 1000).toISOString()}`);
      }
      return {
        disclosure: { address, action: cfg.action, detail, build: (_v, dry) => built.call(dry), unverified: false },
        summary: cfg.action,
      };
    },

    renderPlan: renderProposePlan,

    async commit(ctx, planned) {
      await ctx.requireSigner();
      const vault = ctx.qv.vault(planned.disclosure.address);
      const result = await planned.disclosure.build(vault, false);
      if (isDryRun(result)) {
        return {
          data: { address: planned.disclosure.address, action: cfg.action },
          changed: false,
        };
      }
      const proposed = result;
      await vault.waitForIndexer().catch(() => undefined);
      return {
        data: {
          address: planned.disclosure.address,
          txHash: proposed.txHash,
          chainTxHash: proposed.chainTxHash,
          to: proposed.to,
          value: proposed.value,
          data: proposed.data,
          action: cfg.action,
        },
        changed: true,
        retryable: false,
        steps: [{ name: 'propose', status: 'ok', chainTxHash: proposed.chainTxHash }],
        next: [`qv tx show ${planned.disclosure.address} ${proposed.txHash.slice(0, 10)}`],
      };
    },

    render: proposeResultRender,
    toJson: (r) => proposeJson(r) as never,
    outputSchema: proposeSchema,
  };
}

// ------------------------------------------------------------------ transfers

export const proposeTransferCommand = makeProposeCommand<
  ProposeCommon & { to: string; amount?: string; amountWei?: string }
>({
  path: ['propose', 'transfer'],
  describe: 'Propose sending native QUAI',
  options: [
    { flags: '--to <address>', description: 'recipient' },
    { flags: '--amount <quai>', description: 'amount in decimal QUAI' },
    { flags: '--amount-wei <wei>', description: 'amount in raw wei' },
  ],
  action: 'transfer QUAI',
  build: (_ctx, _vault, input, timing) => {
    const to = assertRecipient(requireFlag(input.to, '--to'));
    const amount = resolveAmount(input.amount, input.amountWei, 18);
    return Promise.resolve({
      detail: [`To:     ${to}`, `Amount: ${formatQuai(amount)} QUAI  (exactly ${amount} wei)`],
      call: (dryRun: boolean) => _vault.propose.transfer({ to, amount, ...timing, dryRun }),
    });
  },
});

export const proposeTokenCommand = makeProposeCommand<
  ProposeCommon & { token: string; to: string; amount?: string; amountWei?: string; decimals?: string }
>({
  path: ['propose', 'token'],
  describe: 'Propose an ERC-20 transfer',
  options: [
    { flags: '--token <address>', description: 'token contract' },
    { flags: '--to <address>', description: 'recipient' },
    { flags: '--amount <units>', description: 'amount in decimal token units' },
    { flags: '--amount-wei <raw>', description: 'amount in raw base units' },
    { flags: '--decimals <n>', description: 'token decimals (default 18)', defaultValue: '18' },
  ],
  action: 'transfer ERC-20 tokens',
  build: (_ctx, vault, input, timing) => {
    const token = assertRecipient(requireFlag(input.token, '--token'), 'token');
    const to = assertRecipient(requireFlag(input.to, '--to'));
    const decimals = Number(input.decimals ?? 18);
    const amount = resolveAmount(input.amount, input.amountWei, decimals);
    return Promise.resolve({
      detail: [
        `Token:  ${token}`,
        `To:     ${to}`,
        `Amount: ${formatUnits(amount, decimals)}  (exactly ${amount} base units)`,
      ],
      call: (dryRun: boolean) => vault.propose.erc20Transfer({ token, to, amount, ...timing, dryRun }),
    });
  },
});

export const proposeNftCommand = makeProposeCommand<
  ProposeCommon & { token: string; to: string; tokenId: string }
>({
  path: ['propose', 'nft'],
  describe: 'Propose an ERC-721 transfer',
  options: [
    { flags: '--token <address>', description: 'collection contract' },
    { flags: '--to <address>', description: 'recipient' },
    { flags: '--token-id <id>', description: 'token id' },
  ],
  action: 'transfer an NFT',
  build: (_ctx, vault, input, timing) => {
    const token = assertRecipient(requireFlag(input.token, '--token'), 'token');
    const to = assertRecipient(requireFlag(input.to, '--to'));
    const tokenId = BigInt(requireFlag(input.tokenId, '--token-id'));
    return Promise.resolve({
      detail: [`Token:  ${token}`, `To:     ${to}`, `Id:     #${tokenId}`],
      call: (dryRun: boolean) => vault.propose.erc721Transfer({ token, to, tokenId, ...timing, dryRun }),
    });
  },
});

export const proposeCallCommand = makeProposeCommand<
  ProposeCommon & { to: string; data?: string; value?: string }
>({
  path: ['propose', 'call'],
  describe: 'Propose an arbitrary contract call from raw calldata',
  options: [
    { flags: '--to <address>', description: 'target contract' },
    { flags: '--data <hex>', description: 'raw calldata' },
    { flags: '--value <quai>', description: 'QUAI to send alongside', defaultValue: '0' },
  ],
  action: 'call a contract',
  build: (_ctx, vault, input, timing) => {
    const to = assertRecipient(requireFlag(input.to, '--to'), 'target');
    const data = (input.data ?? '0x') as `0x${string}`;
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) {
      throw new UsageError('--data must be 0x-prefixed hex with an even number of digits.');
    }
    const value = parseQuai(input.value ?? '0');
    return Promise.resolve({
      detail: [
        `To:     ${to}`,
        `Value:  ${formatQuai(value)} QUAI`,
        `Data:   ${data.length > 2 ? `${(data.length - 2) / 2} bytes` : '(none)'}`,
      ],
      call: (dryRun: boolean) => vault.propose.call({ to, value, data, ...timing, dryRun }),
    });
  },
});

// ------------------------------------------------------------ administration

export const proposeAddOwnerCommand = makeProposeCommand<ProposeCommon & { owner: string }>({
  path: ['propose', 'add-owner'],
  describe: 'Propose adding an owner',
  args: [{ name: 'owner', description: 'address to add', required: true }],
  action: 'add an owner',
  build: (_ctx, vault, input, timing) => {
    const owner = assertRecipient(input.owner, 'owner');
    return Promise.resolve({
      detail: [`Owner:  ${owner}`],
      call: (dryRun: boolean) => vault.propose.addOwner(owner, { ...timing, dryRun }),
    });
  },
});

export const proposeRemoveOwnerCommand = makeProposeCommand<ProposeCommon & { owner: string }>({
  path: ['propose', 'remove-owner'],
  describe: 'Propose removing an owner',
  args: [{ name: 'owner', description: 'address to remove', required: true }],
  action: 'remove an owner',
  build: async (_ctx, vault, input, timing) => {
    const info = await vault.info();
    const remaining = info.owners.filter(
      (o) => o.toLowerCase() !== input.owner.toLowerCase(),
    ).length;
    if (remaining === info.owners.length) {
      throw new UsageError(`${input.owner} is not an owner of this vault.`);
    }
    // The GUI hid this button with no explanation. A blocked action becomes an
    // explicit typed error instead.
    if (remaining < info.threshold) {
      throw new PreconditionError(
        `Removing this owner would leave ${remaining} owners with a threshold of ${info.threshold}.`,
        `Lower the threshold first: qv propose threshold <vault> ${remaining}`,
      );
    }
    return {
      detail: [
        `Owner:  ${input.owner}`,
        `Result: ${info.threshold} of ${remaining} owners`,
      ],
      call: (dryRun: boolean) => vault.propose.removeOwner(input.owner, { ...timing, dryRun }),
    };
  },
});

export const proposeThresholdCommand = makeProposeCommand<ProposeCommon & { threshold: string }>({
  path: ['propose', 'threshold'],
  describe: 'Propose changing the approval threshold',
  args: [{ name: 'threshold', description: 'new threshold', required: true }],
  action: 'change the threshold',
  build: async (_ctx, vault, input, timing) => {
    const threshold = Number(input.threshold);
    const info = await vault.info();
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > info.owners.length) {
      throw new UsageError(
        `Threshold must be between 1 and ${info.owners.length} (the current owner count).`,
      );
    }
    return {
      detail: [`Threshold: ${info.threshold} → ${threshold} of ${info.owners.length}`],
      call: (dryRun: boolean) => vault.propose.changeThreshold(threshold, { ...timing, dryRun }),
    };
  },
});

export const proposeDelayCommand = makeProposeCommand<ProposeCommon & { delay: string }>({
  path: ['propose', 'delay'],
  describe: 'Propose changing the vault minimum timelock',
  args: [{ name: 'delay', description: 'new minimum delay (e.g. 24h, or 0)', required: true }],
  action: 'change the minimum timelock',
  build: async (_ctx, vault, input, timing) => {
    const seconds = parseDuration(input.delay);
    if (seconds > MAX_EXECUTION_DELAY) {
      throw new UsageError(
        `${formatDuration(seconds)} exceeds the contract maximum of ${formatDuration(MAX_EXECUTION_DELAY)}.`,
      );
    }
    const info = await vault.info();
    return {
      detail: [
        `Timelock: ${formatDuration(info.minExecutionDelay)} → ${formatDuration(seconds)}`,
      ],
      call: (dryRun: boolean) => vault.propose.setMinExecutionDelay(seconds, { ...timing, dryRun }),
    };
  },
});

export const proposeCancelByConsensusCommand = makeProposeCommand<ProposeCommon & { hash: string }>({
  path: ['propose', 'cancel-by-consensus'],
  describe: 'Propose cancelling a transaction that has already reached quorum',
  args: [{ name: 'hash', description: 'transaction hash to cancel', required: true }],
  action: 'cancel a transaction by consensus',
  build: (_ctx, vault, input, timing) => {
    const hash = input.hash.startsWith('0x') ? input.hash : `0x${input.hash}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new UsageError('Pass the full 66-character transaction hash.');
    }
    return Promise.resolve({
      detail: [
        `Cancels: ${hash}`,
        'This is a NEW proposal that itself needs approvals.',
      ],
      call: (dryRun: boolean) => vault.propose.cancelByConsensus(hash, { ...timing, dryRun }),
    });
  },
});

export const proposeModuleCommand = makeProposeCommand<
  ProposeCommon & { action: string; module: string }
>({
  path: ['propose', 'module'],
  describe: 'Propose enabling or disabling a module',
  args: [
    { name: 'action', description: 'enable | disable', required: true },
    { name: 'module', description: 'module address', required: true },
  ],
  action: 'change module configuration',
  build: async (ctx, vault, input, timing) => {
    const module = assertRecipient(input.module, 'module');
    if (input.action !== 'enable' && input.action !== 'disable') {
      throw new UsageError('Usage: qv propose module <enable|disable> <address>');
    }
    // The GUI never accepted a free-text module address; the CLI does, so an
    // unknown module needs the same second flag an unverified decode does.
    const known = await vault.isModuleEnabled(module).catch(() => false);
    if (input.action === 'enable' && !known && !ctx.flags.iUnderstandUnverified) {
      throw new PreconditionError(
        `${module} is not a module this vault already knows.`,
        'Enabling a module grants it authority over the vault. Re-run with --i-understand-unverified if you are sure.',
      );
    }
    return {
      detail: [`Module: ${module}`, `Action: ${input.action}`],
      call: (dryRun: boolean) =>
        input.action === 'enable'
          ? vault.propose.enableModule(module, { ...timing, dryRun })
          : vault.propose.disableModule(module, { ...timing, dryRun }),
    };
  },
});

export const proposeDelegatecallCommand = makeProposeCommand<
  ProposeCommon & { action: string; target: string }
>({
  path: ['propose', 'delegatecall'],
  describe: 'Propose adding or removing a DelegateCall target',
  args: [
    { name: 'action', description: 'add | rm', required: true },
    { name: 'target', description: 'target address', required: true },
  ],
  action: 'change the DelegateCall whitelist',
  build: (ctx, vault, input, timing) => {
    const target = assertRecipient(input.target, 'target');
    if (input.action !== 'add' && input.action !== 'rm') {
      throw new UsageError('Usage: qv propose delegatecall <add|rm> <address>');
    }
    if (input.action === 'add' && !ctx.flags.iUnderstandUnverified) {
      throw new PreconditionError(
        'Whitelisting a DelegateCall target lets it rewrite this vault’s storage.',
        'That is the strongest authority the vault can grant. Re-run with --i-understand-unverified if you are sure.',
      );
    }
    return Promise.resolve({
      detail: [
        `Target: ${target}`,
        `Action: ${input.action === 'add' ? 'ALLOW DelegateCall' : 'remove'}`,
      ],
      call: (dryRun: boolean) =>
        input.action === 'add'
          ? vault.propose.addDelegatecallTarget(target, { ...timing, dryRun })
          : vault.propose.removeDelegatecallTarget(target, { ...timing, dryRun }),
    });
  },
});

export const proposeSignMessageCommand = makeProposeCommand<
  ProposeCommon & { message: string; unsign?: boolean }
>({
  path: ['propose', 'sign-message'],
  describe: 'Propose signing (or unsigning) an EIP-1271 message',
  args: [{ name: 'message', description: 'message as 0x hex', required: true }],
  options: [{ flags: '--unsign', description: 'revoke a previously signed message', defaultValue: false }],
  action: 'sign a message',
  build: (ctx, vault, input, timing) => {
    const message = input.message as `0x${string}`;
    if (!/^0x([0-9a-fA-F]{2})*$/.test(message)) {
      throw new UsageError('The message must be 0x-prefixed hex.');
    }
    // A bare 32-byte value could be another vault's transaction hash. Signing
    // it blind is how an EIP-1271 attestation gets misused.
    if (!input.unsign && message.length === 66 && !ctx.flags.iUnderstandUnverified) {
      throw new PreconditionError(
        'That message is exactly 32 bytes, which could be a transaction hash rather than text.',
        'Signing it would attest to whatever it represents. Re-run with --i-understand-unverified if you are sure.',
      );
    }
    return Promise.resolve({
      detail: [`Message: ${message.length > 130 ? `${message.slice(0, 130)}…` : message}`],
      call: (dryRun: boolean) =>
        input.unsign
          ? vault.propose.unsignMessage(message, { ...timing, dryRun })
          : vault.propose.signMessage(message, { ...timing, dryRun }),
    });
  },
});

function requireFlag(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`${flag} is required.`);
  return value;
}

/**
 * `--amount` is always decimal units; `--amount-wei` is always raw.
 *
 * Accepting a bare integer as either is a money-loss bug class, so the two
 * never overlap and supplying both is an error rather than a precedence rule.
 */
function resolveAmount(
  amount: string | undefined,
  amountWei: string | undefined,
  decimals: number,
): bigint {
  if (amount && amountWei) {
    throw new UsageError('Pass either --amount or --amount-wei, not both.');
  }
  if (amountWei !== undefined) {
    if (!/^\d+$/.test(amountWei.trim())) {
      throw new UsageError('--amount-wei must be a whole number of base units.');
    }
    return BigInt(amountWei.trim());
  }
  if (amount === undefined) throw new UsageError('--amount is required.');
  return decimals === 18 ? parseQuai(amount) : parseUnits(amount, decimals);
}

export const PROPOSE_COMMANDS = [
  proposeTransferCommand,
  proposeTokenCommand,
  proposeNftCommand,
  proposeCallCommand,
  proposeAddOwnerCommand,
  proposeRemoveOwnerCommand,
  proposeThresholdCommand,
  proposeDelayCommand,
  proposeCancelByConsensusCommand,
  proposeModuleCommand,
  proposeDelegatecallCommand,
  proposeSignMessageCommand,
] as CommandSpec[];
