import { mainnet, interfaces } from '@quaivault/sdk';
import { ResultStore } from '../src/store/index.js';
import type {
  Affordance,
  IndexerHealth,
  QuaiVaultClient,
  VaultInfo,
  VaultTransaction,
  Page,
} from '@quaivault/sdk';
import type { AppContext, GlobalFlags } from '../src/context/context.js';
import { createBufferIo } from '../src/render/io.js';
import type { CliConfig } from '../src/context/config.js';
import type { Policy } from '../src/context/policy.js';

/**
 * A hand-written fake, typed against the real SDK — **not `vi.mock`**.
 *
 * A module mock does not typecheck against the SDK, so when the SDK changes a
 * return shape the tests stay green while the CLI is broken. This fake fails
 * `npm run typecheck` on the same change, which is the whole point: it is the
 * main defence against drift in a dependency that shipped six releases in two
 * days (plan §6, Tier 2).
 */
export interface FakeVaultState {
  info: VaultInfo;
  pending: VaultTransaction[];
  history: VaultTransaction[];
  affordances: Record<string, Affordance[]>;
  hasPendingRecovery: boolean;
  /** What the acting identity may do to the pending recovery. */
  recoveryAffordances: { action: string; allowed: boolean; reason: string }[];
}

export interface FakeOptions {
  vaults?: Record<string, Partial<FakeVaultState>>;
  health?: Partial<IndexerHealth>;
  forOwner?: string[];
  forGuardian?: string[];
}

export const ADDR = {
  vault: '0x005f2629A632962f4944d23686efDa5c160d535b',
  alice: '0x001f4e8a9b0c1d2e3f405162738495a6b7c8d781',
  bob: '0x00a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3',
  carol: '0x0072aa11bb22cc33dd44ee55ff66007788990aa1',
  token: '0x0033333333333333333333333333333333333333',
} as const;

export function fakeVaultInfo(over: Partial<VaultInfo> = {}): VaultInfo {
  return {
    address: ADDR.vault,
    owners: [ADDR.alice, ADDR.bob, ADDR.carol],
    threshold: 2,
    minExecutionDelay: 0,
    nonce: 3,
    balance: 1_240_503_100_000_000_000_000n,
    moduleCount: 1,
    ...over,
  };
}

export function fakeTx(over: Partial<VaultTransaction> = {}): VaultTransaction {
  return {
    hash: `0x${'8a3f9c21'.repeat(8)}`,
    vault: ADDR.vault,
    to: ADDR.alice,
    value: 100_000_000_000_000_000_000n,
    data: '0x',
    proposer: ADDR.bob,
    proposedAt: 0,
    proposedAtBlock: 9_272_800,
    kind: 'transfer',
    summary: 'Transfer 100 QUAI to 0x001f…d781',
    abiSource: 'builtin',
    status: 'pending',
    approvals: [
      { owner: ADDR.bob, active: true },
      { owner: ADDR.alice, active: false },
    ],
    approvalCount: 1,
    threshold: 2,
    expiration: 0,
    executionDelay: 0,
    approvedAt: 0,
    executableAfter: 0,
    source: 'indexer',
    ...over,
  };
}

export function fakeAffordance(over: Partial<Affordance> = {}): Affordance {
  return { action: 'approve', allowed: true, reason: 'You are an owner and have not approved.', ...over };
}

function page<T>(data: T[]): Page<T> {
  return { data, total: data.length, hasMore: false };
}

export function createFakeClient(opts: FakeOptions = {}): QuaiVaultClient {
  const health: IndexerHealth = {
    available: true,
    lastIndexedBlock: 9_272_851,
    chainHead: 9_272_855,
    blocksBehind: 4,
    isSyncing: false,
    ...opts.health,
  };

  const stateFor = (address: string): FakeVaultState => {
    const over = opts.vaults?.[address.toLowerCase()] ?? opts.vaults?.[address] ?? {};
    return {
      info: fakeVaultInfo({ address }),
      pending: [],
      history: [],
      affordances: {},
      hasPendingRecovery: false,
      recoveryAffordances: [],
      ...over,
    };
  };

  const vault = (address: string) => {
    const st = stateFor(address);
    return {
      info: () => Promise.resolve(st.info),
      modules: () => Promise.resolve([]),
      pendingTransactions: () => Promise.resolve(st.pending),
      transactionHistory: () => Promise.resolve(page(st.history)),
      transaction: (hash: string) => {
        const found = [...st.pending, ...st.history].find(
          (t) => t.hash.toLowerCase() === hash.toLowerCase(),
        );
        if (!found) return Promise.reject(new Error(`no such transaction ${hash}`));
        return Promise.resolve(found);
      },
      affordances: (hash: string) => Promise.resolve(st.affordances[hash] ?? []),
      balances: () => Promise.resolve({ native: st.info.balance, tokens: [] }),
      signedMessages: () => Promise.resolve([]),
      propose: {
        transfer: (params: { to: string; amount: bigint; dryRun?: boolean }) =>
          Promise.resolve(
            params.dryRun
              ? {
                  dryRun: true as const,
                  to: params.to,
                  value: params.amount,
                  data: '0x',
                  gasEstimate: 21_000n,
                  description: 'transfer',
                }
              : {
                  txHash: `0x${'aa'.repeat(32)}`,
                  chainTxHash: `0x${'bb'.repeat(32)}`,
                  to: params.to,
                  value: params.amount,
                  data: '0x',
                },
          ),
      },
      recovery: {
        hasPending: () => Promise.resolve(st.hasPendingRecovery),
        // The real SDK has this; the fake did not, so anything calling it hit
        // a synchronous TypeError that no `.catch` could see.
        affordances: () => Promise.resolve(st.recoveryAffordances),
        pending: () =>
          Promise.resolve(
            st.hasPendingRecovery
              ? [
                  {
                    hash: `0x${'re'.repeat(32)}`,
                    vault: address,
                    newOwners: [ADDR.carol],
                    newThreshold: 1,
                    approvalCount: 2,
                    requiredThreshold: 2,
                    executionTime: Math.floor(Date.now() / 1000) + 3600,
                    expiration: Math.floor(Date.now() / 1000) + 86_400,
                    status: 'pending' as const,
                    executed: false,
                    source: 'indexer' as const,
                  },
                ]
              : [],
          ),
      },
    };
  };

  const chainContract = (address: string) => {
    const st = stateFor(address);
    const find = (hash: string): VaultTransaction => {
      const tx = [...st.pending, ...st.history].find(
        (candidate) => candidate.hash.toLowerCase() === hash.toLowerCase(),
      );
      if (!tx) throw new Error(`no such transaction ${hash}`);
      return tx;
    };
    return {
      transactions: (hash: string) => {
        const tx = find(hash);
        return Promise.resolve({
          to: tx.to,
          value: tx.value,
          data: tx.data,
          proposer: tx.proposer,
          timestamp: tx.proposedAt,
          expiration: tx.expiration,
          executionDelay: tx.executionDelay,
          approvedAt: tx.approvedAt,
          executed: tx.status === 'executed' || tx.status === 'failed',
          cancelled: tx.status === 'cancelled' || tx.status === 'expired',
        });
      },
      getOwners: () => Promise.resolve(st.info.owners),
      threshold: () => Promise.resolve(st.info.threshold),
      expiredTxs: (hash: string) => Promise.resolve(find(hash).status === 'expired'),
      hasApproved: (hash: string, owner: string) =>
        Promise.resolve(
          find(hash).approvals.some(
            (approval) => approval.active && approval.owner.toLowerCase() === owner.toLowerCase(),
          ),
        ),
    };
  };

  return {
    indexerHealth: () => Promise.resolve(health),
    vault,
    vaults: {
      forOwner: () => Promise.resolve(opts.forOwner ?? []),
      forGuardian: () => Promise.resolve(opts.forGuardian ?? []),
    },
    // The real mainnet config rather than invented addresses: the batch
    // analysis keys `socialRecovery` and `multiSendCallOnly` off these when
    // it decodes sub-calls, so a hand-written stub here would exercise a
    // decode path no user ever hits.
    network: mainnet,
    abis: undefined,
    now: () => Math.floor(Date.now() / 1000),
    config: { contracts: mainnet.contracts },
    connection: { vault: chainContract },
  } as unknown as QuaiVaultClient;
}

export function fakeFlags(over: Partial<GlobalFlags> = {}): GlobalFlags {
  return {
    json: false,
    yes: false,
    noInput: true,
    quiet: false,
    debug: false,
    wide: false,
    color: 'never',
    dryRun: false,
    iUnderstandUnverified: false,
    ...over,
  };
}

export interface FakeContextOptions {
  client?: QuaiVaultClient;
  flags?: Partial<GlobalFlags>;
  identity?: string;
  aliases?: Record<string, string>;
  contacts?: Record<string, string>;
  policy?: Policy | null;
  interactive?: boolean;
  now?: number;
}

export function createFakeContext(opts: FakeContextOptions = {}): AppContext & {
  io: ReturnType<typeof createBufferIo>;
} {
  const io = createBufferIo(80);
  const config: CliConfig = {
    defaultProfile: 'default',
    profiles: { default: { network: 'mainnet', address: opts.identity } },
    aliases: opts.aliases ?? {},
    contacts: opts.contacts ?? {},
  };
  const reverse = new Map(
    Object.entries(config.contacts).map(([n, a]) => [a.toLowerCase(), n] as const),
  );
  const fixedNow = opts.now ?? 1_785_000_000;
  return {
    qv: opts.client ?? createFakeClient(),
    config,
    profile: config.profiles.default!,
    profileName: 'default',
    flags: fakeFlags(opts.flags),
    io,
    now: () => fixedNow,
    skew: { offsetSeconds: 0, detected: false },
    policy: opts.policy ?? null,
    store: new ResultStore(() => fixedNow),
    interactive: opts.interactive ?? false,
    resolveVault(nameOrAddress) {
      const c = nameOrAddress ?? ADDR.vault;
      return config.aliases[c] ?? c;
    },
    contactName: (address) => reverse.get(address.toLowerCase()),
    identity: () => opts.identity,
    requireSigner: () =>
      Promise.resolve({
        signer: {} as never,
        address: opts.identity ?? ADDR.bob,
      }),
  };
}

// --------------------------------------------------------------- batch fixtures

/**
 * MultiSend payload builders (plan §7).
 *
 * Hand-packed to the wire layout — `operation(1) ‖ to(20) ‖ value(32) ‖
 * dataLength(32) ‖ data` — rather than built with `encodeMultiSendPayload`,
 * because the SDK's encoder always writes operation 0. MultiSendCallOnly
 * rejects nested delegatecall, so the encoder cannot produce the input the
 * delegatecall gate exists to catch. An attacker-authored proposal is under no
 * such constraint.
 */
export function multiSendEntry(
  operation: number,
  to: string,
  value: bigint,
  data: string,
): string {
  const body = data.replace(/^0x/, '');
  return (
    operation.toString(16).padStart(2, '0') +
    to.replace(/^0x/, '').toLowerCase() +
    value.toString(16).padStart(64, '0') +
    (body.length / 2).toString(16).padStart(64, '0') +
    body
  );
}

export function multiSendCalldata(payload: string): string {
  return interfaces.multiSend.encodeFunctionData('multiSend', [payload]);
}

export function batchOf(...entries: string[]): string {
  return multiSendCalldata('0x' + entries.join(''));
}

export const erc20Transfer = (to: string, amount: bigint): string =>
  interfaces.erc20.encodeFunctionData('transfer', [to, amount]);

/** Two ordinary calls: what a well-formed treasury batch looks like. */
export function batchOfTwo(): string {
  return batchOf(
    multiSendEntry(0, ADDR.carol, 1_000_000_000_000_000_000n, '0x'),
    multiSendEntry(0, ADDR.token, 0n, erc20Transfer(ADDR.bob, 42n)),
  );
}

/** A delegatecall hidden behind two innocuous calls. */
export function batchWithDelegatecall(): string {
  return batchOf(
    multiSendEntry(0, ADDR.carol, 1n, '0x'),
    multiSendEntry(0, ADDR.token, 0n, erc20Transfer(ADDR.bob, 1n)),
    multiSendEntry(1, ADDR.alice, 0n, '0xdeadbeef'),
  );
}

/** A valid entry with bytes trailing it that the SDK's decoder discards. */
export function unreadableBatch(): string {
  return multiSendCalldata('0x' + multiSendEntry(0, ADDR.carol, 0n, '0x') + 'abcd');
}

/**
 * A batch every sub-call of which the SDK genuinely vouches for.
 *
 * Native transfers only. An ERC-20 `transfer` decodes as `heuristic`, not
 * `builtin` — the SDK is matching a 4-byte selector against an address it
 * cannot confirm is a token contract at all — so a batch containing one is
 * correctly refused by `require_abi_source = ["builtin"]`.
 */
export function batchOfBuiltins(): string {
  return batchOf(
    multiSendEntry(0, ADDR.carol, 1_000_000_000_000_000_000n, '0x'),
    multiSendEntry(0, ADDR.bob, 2_000_000_000_000_000_000n, '0x'),
  );
}
