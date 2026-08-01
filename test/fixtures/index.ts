import {
  AbortError,
  ConfigError,
  NoIndexerError,
  NoSignerError,
  NotFoundError,
  PreconditionError,
  RevertError,
  SaltMiningError,
  StaleProposalError,
  ValidationError,
  IndexerQueryError,
} from '@quaivault/sdk';
import type {
  AbiSource,
  ExecuteOutcome,
  ExecuteResult,
  QuaiVaultError,
  VaultTransaction,
} from '@quaivault/sdk';
import {
  ADDR,
  batchOfBuiltins,
  batchOfTwo,
  batchWithDelegatecall,
  fakeTx,
  unreadableBatch,
} from '../fake-client.js';

/**
 * Tier 3 — the fixture corpus (plan §6).
 *
 * "Recorded payloads typed as SDK types, covering all four ExecuteOutcomes,
 * all four abiSources, every error class."
 *
 * Typed as the real SDK types on purpose. A hand-rolled shape would drift the
 * moment the SDK changed a field and every test over it would stay green
 * while describing a world that no longer exists — the whole failure Tier 4
 * exists to catch, reintroduced one layer down.
 *
 * These back two exit criteria that are otherwise untestable: Phase 1's
 * "every bigint a decimal string, asserted over the fixture corpus", and
 * Phase 3's "all four ExecuteOutcomes map to correct exit codes, one fixture
 * test each".
 */

// ------------------------------------------------------------ abiSource × 4

/**
 * One transaction per decode provenance. `heuristic` is the interesting one:
 * the SDK deliberately does not hedge its summary — "the field carries the
 * uncertainty instead" — so the CLI is the only place a reviewer learns that
 * "Transfer 100 USDC" was a four-byte guess against an address that may have
 * no code at all.
 */
export const ABI_SOURCE_FIXTURES: Record<AbiSource, VaultTransaction> = {
  builtin: fakeTx({
    hash: `0x${'b1'.repeat(32)}`,
    abiSource: 'builtin',
    summary: 'Transfer 1.0 QUAI to 0x0072…0aa1',
    kind: 'transfer',
    data: '0x',
    value: 1_000_000_000_000_000_000n,
  }),
  heuristic: fakeTx({
    hash: `0x${'a2'.repeat(32)}`,
    abiSource: 'heuristic',
    summary: 'Transfer 42 units of token 0x0033…3333 to 0x00A1…b2C3',
    kind: 'erc20_transfer',
    data: `0xa9059cbb${'0'.repeat(24)}${ADDR.bob.slice(2).toLowerCase()}${'0'.repeat(62)}2a`,
  }),
  supplied: fakeTx({
    hash: `0x${'c3'.repeat(32)}`,
    abiSource: 'supplied',
    summary: 'stake(uint256) — decoded from a user-supplied ABI',
    kind: 'external_call',
    data: `0xa694fc3a${'0'.repeat(63)}1`,
  }),
  none: fakeTx({
    hash: `0x${'d4'.repeat(32)}`,
    abiSource: 'none',
    summary: 'Unknown call',
    kind: 'unknown',
    data: `0xdeadbeef${'11'.repeat(32)}${'22'.repeat(32)}`,
  }),
};

// -------------------------------------------------------------- batch shapes

export const BATCH_FIXTURES = {
  /** Every sub-call vouched for by the SDK. */
  builtins: fakeTx({
    hash: `0x${'e5'.repeat(32)}`,
    kind: 'batched_call',
    abiSource: 'builtin',
    summary: 'Batched call: 2 sub-transactions',
    data: batchOfBuiltins(),
  }),
  /** Mixed provenance: the outer decode is builtin, a sub-call is a guess. */
  mixed: fakeTx({
    hash: `0x${'f6'.repeat(32)}`,
    kind: 'batched_call',
    abiSource: 'builtin',
    summary: 'Batched call: 2 sub-transactions',
    data: batchOfTwo(),
  }),
  /** The case the whole gate exists for. */
  delegatecall: fakeTx({
    hash: `0x${'a7'.repeat(32)}`,
    kind: 'batched_call',
    abiSource: 'builtin',
    summary: 'Batched call: 3 sub-transactions',
    data: batchWithDelegatecall(),
  }),
  /** Bytes the decoder silently drops. Must fail closed. */
  unreadable: fakeTx({
    hash: `0x${'b8'.repeat(32)}`,
    kind: 'batched_call',
    abiSource: 'builtin',
    summary: 'Batched call: 1 sub-transaction',
    data: unreadableBatch(),
  }),
} satisfies Record<string, VaultTransaction>;

// -------------------------------------------------------- ExecuteOutcome × 4

/**
 * All four outcomes, each with the fields the SDK populates only for it —
 * `executableAfter` for `timelock_started`, `approvalsNeeded` for
 * `approved_only`, `decodedRevert` for `failed`.
 *
 * `failed` is the one worth being loud about: the chain transaction
 * succeeded and the vault call did not. Appendix A records a UI that checked
 * only the outer receipt status and rendered a green check for it.
 */
export const EXECUTE_FIXTURES: Record<ExecuteOutcome, ExecuteResult> = {
  executed: {
    outcome: 'executed',
    txHash: `0x${'11'.repeat(32)}`,
    chainTxHash: `0x${'21'.repeat(32)}`,
    blockNumber: 9_272_900,
    gasUsed: 148_221n,
    message: 'Executed.',
  },
  failed: {
    outcome: 'failed',
    txHash: `0x${'12'.repeat(32)}`,
    chainTxHash: `0x${'22'.repeat(32)}`,
    blockNumber: 9_272_901,
    gasUsed: 91_004n,
    returnData: '0x08c379a0',
    decodedRevert: {
      message: 'ERC20: transfer amount exceeds balance',
      selector: '0x08c379a0',
      args: { reason: 'ERC20: transfer amount exceeds balance' },
    },
    message: 'The vault call reverted.',
  } as unknown as ExecuteResult,
  timelock_started: {
    outcome: 'timelock_started',
    txHash: `0x${'13'.repeat(32)}`,
    chainTxHash: `0x${'23'.repeat(32)}`,
    blockNumber: 9_272_902,
    gasUsed: 74_310n,
    executableAfter: 1_800_090_000,
    message: 'Quorum reached; the timelock clock has started.',
  },
  approved_only: {
    outcome: 'approved_only',
    txHash: `0x${'14'.repeat(32)}`,
    chainTxHash: `0x${'24'.repeat(32)}`,
    blockNumber: 9_272_903,
    gasUsed: 66_100n,
    approvalsNeeded: 1,
    message: 'Approved. One more approval is needed.',
  } as unknown as ExecuteResult,
};

// ------------------------------------------------------------- error classes

/**
 * One instance of every SDK error class, so the renderer and the exit-code
 * mapping are exercised against real `toJSON()` output rather than a
 * hand-written `{code, message}` that cannot drift.
 */
export const ERROR_FIXTURES: Record<string, QuaiVaultError> = {
  AbortError: new AbortError('The read was cancelled.'),
  ConfigError: new ConfigError('QUAIVAULT_RPC_URL is not a valid URL.'),
  IndexerQueryError: new IndexerQueryError('relation "transactions" does not exist'),
  NoIndexerError: new NoIndexerError('No indexer is configured for this network.'),
  NoSignerError: new NoSignerError('This command signs; no key is unlocked.'),
  NotFoundError: new NotFoundError('No such transaction on this vault.'),
  PreconditionError: new PreconditionError('The timelock has not elapsed.'),
  RevertError: new RevertError('execution reverted'),
  SaltMiningError: new SaltMiningError('No salt found within the attempt budget.'),
  StaleProposalError: new StaleProposalError('The vault nonce has moved past this proposal.'),
  ValidationError: new ValidationError('Not a usable Quai address.'),
};

/** Everything a JSON-serialization sweep should walk. */
export const ALL_TRANSACTIONS: VaultTransaction[] = [
  ...Object.values(ABI_SOURCE_FIXTURES),
  ...Object.values(BATCH_FIXTURES),
];
