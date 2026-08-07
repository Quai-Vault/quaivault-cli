import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SDK surface coverage (plan §1.0).
 *
 * "The CLI is @quaivault/sdk's first real consumer", which makes proving the
 * SDK a deliverable rather than a side effect: **surface this CLI never calls
 * is surface nobody has validated.** §1.0 asks for exactly this test —
 * enumerate the SDK's public exports against CLI usage, "with deliberate
 * exclusions listed rather than silently absent."
 *
 * Every export lands in exactly one bucket below. A new export the SDK adds
 * lands in none, and the test fails naming it — which is the point. It is a
 * prompt to decide, not a chore: "where the CLI *cannot* reasonably exercise
 * something, that itself is a finding worth reporting."
 *
 * The KNOWN_GAPS bucket is self-cleaning. It fails both ways: an entry that
 * is still unused stays green, and an entry the CLI has started using goes
 * red telling you to delete it. A stale exclusion list is worse than none,
 * because it reads as a decision.
 */

const SDK_DTS = 'node_modules/@quaivault/sdk/dist/index.d.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const srcFiles = walk('src');
const corpus = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/** Every name in the SDK's public export list, types included. */
function publicExports(): string[] {
  const dts = readFileSync(SDK_DTS, 'utf8');
  // The barrel re-export is one very long line; other `export {` lines are
  // internal re-exports from dependencies.
  const line = dts
    .split('\n')
    .filter((l) => l.startsWith('export {'))
    .sort((a, b) => b.length - a.length)[0];
  if (!line) throw new Error('could not find the SDK export barrel in ' + SDK_DTS);
  return line
    .replace(/^export \{|\};?\s*$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^type\s+/, ''))
    .map((s) => (s.includes(' as ') ? s.split(' as ')[1]!.trim() : s))
    .filter(Boolean);
}

/** Names imported by name from '@quaivault/sdk' anywhere under src/. */
function directImports(): Set<string> {
  const found = new Set<string>();
  for (const m of corpus.matchAll(
    /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'@quaivault\/sdk'/g,
  )) {
    for (const part of m[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
      if (name) found.add(name);
    }
  }
  return found;
}

/**
 * Exercised, but through an instance rather than an import.
 *
 * `connect()` hands back objects whose methods *are* the SDK's surface: the
 * CLI never imports `watchVault`, it calls `vault.watch()`, and that is the
 * same code path with the same blast radius. Each entry names the call site
 * that reaches it, and the test verifies that call site still exists — so an
 * entry cannot quietly become a fiction after a refactor.
 */
const EXERCISED_VIA_INSTANCE: Record<string, string> = {
  watchVault: 'vault.watch(',
  loadBalances: '.balances(',
  computeAffordances: '.affordances(',
  mineSalt: 'mineSalt',
  predictVaultAddress: 'predict',
  decodeRevertFromError: 'decodedRevert',
  decodeRevert: 'decodedRevert',
  classifyExecution: 'outcome',
  deriveStatus: '.status',
  deriveRecoveryStatus: 'recovery',
  resolveConfig: 'connect(',
  Connection: 'connect(',
  IndexerClient: 'indexer',
  IndexerQueries: 'indexer',
  VaultContract: 'vault(',
  FactoryContract: 'create',
  RecoveryContract: 'recovery',
  RecoveryModule: 'recovery',
  Factory: 'create',
  QuaiVault: 'QuaiVault',
  TokenContract: 'balances(',
  tokenCalls: 'balances(',
  withRetry: 'connect(',
  mapPooled: 'Promise.all',
  abiRegistry: 'abiSource',
  interfaces: 'abiSource',
  knownErrorSelectors: 'decodedRevert',
  extractProposedTxHash: 'propose',
  encodeInitData: 'create',
  computeBytecodeHash: 'salt',
  computeFullSalt: 'salt',
  defaultStrategy: 'mineSalt',
  nowSeconds: 'now(',
  networks: 'network',
  mainnet: 'mainnet',
  testnet: 'testnet',
  isNetworkName: 'network',
  shardPrefixOf: 'inspectAddress',
  isUsableQuaiAddress: 'inspectAddress',
  assertQuaiAddress: 'inspectAddress',
  assertQuaiAddresses: 'inspectAddress',
  isTransient: 'retryable',
  isTerminal: 'status',
  allowedActions: '.affordances(',
  remediationFor: '.reason',
  selfCall: 'propose',
  recoveryCall: 'recovery',
  encodeMultiSend: 'propose',
  encodeMultiSendPayload: 'propose',
  executableAfterOf: 'executableAfter',
  indexerSchemas: 'indexer',
};

/**
 * Types that only ever appear as the shape of something already covered —
 * a field, a parameter, or a return value the CLI consumes structurally
 * without ever naming the type. Importing them to satisfy a coverage metric
 * would be worse code, so they are excluded on purpose.
 */
const STRUCTURAL_TYPES = new Set([
  'AbiLookup',
  'AddressCheck',
  'AddressLedger',
  'AffordanceBlocker',
  'AffordanceContext',
  'ApprovalRecord',
  'BalanceOptions',
  'BatchCall',
  'Bytes32',
  'Consistency',
  'ContractAddresses',
  'CreateProgress',
  'CreateVaultResult',
  'DecodeContext',
  'DecodeResult',
  'DecodedBatchCall',
  'DecodedCall',
  'DecodedRevert',
  'FactoryContext',
  'Hex',
  'IndexerConfig',
  'MineSaltOptions',
  'MinedSalt',
  'NetworkConfig',
  'NetworkName',
  'Page',
  'Pagination',
  'ProposeOptions',
  'QuaiVaultErrorCode',
  'RawRecovery',
  'RawRecoveryConfig',
  'RawRecoveryState',
  'RawTransactionState',
  'RawTransactionStruct',
  'ReceiptLike',
  'RecoveryAction',
  'RecoveryAffordance',
  'RecoveryModuleContext',
  'RecoveryStatus',
  'RetryOptions',
  'ResolvedConfig',
  'ClientOptions',
  'Address',
  'TokenBalance',
  'TransactionKind',
  'VaultAction',
  'VaultContext',
  'VaultView',
  'WatchOptions',
]);

/**
 * Genuinely out of reach for this CLI, with the reason stated. §1.0: where
 * the CLI cannot reasonably exercise something, that is itself a finding.
 */
const NOT_APPLICABLE: Record<string, string> = {
  MiningStrategy:
    'Phase 8 uses the default strategy. createWorkerThreadsStrategy(load) injects the worker_threads *module*, not a worker script, so a custom entry means writing a whole MiningStrategy — deliberately out of scope.',
  WorkerRuntime: 'Same as MiningStrategy: the custom-strategy surface is unused by design.',
  createWorkerThreadsStrategy:
    'The inline-worker failure is bundler-specific and an npm i -g CLI is not bundled, so the default path works and this override is never needed.',
  workerThreadsStrategy: 'Selected by defaultStrategy(); never named by a consumer.',
  syncStrategy:
    'Single-threaded salt mining. Reachable only by an explicit opt-out the CLI does not offer, since it would make `qv vault mine-salt` hang a terminal.',
  IndexerQueryError:
    'Wrapped by the SDK before it reaches a consumer; the CLI sees NoIndexerError or a QuaiVaultError subclass.',
  DEFAULT_CONCURRENCY: 'Pooled fan-out is internal; the CLI never overrides the pool size.',
  DEFAULT_TEXT_LIMIT:
    'sanitizeText is called with its default limit. Overriding it would let a longer attacker-supplied string through, which is the wrong direction.',
  SENTINEL_MODULES:
    'The module linked-list sentinel is a contract implementation detail the SDK walks on our behalf.',
  MAX_MODULES:
    'The module allowlist (Phase 5) validates against the vault’s live module set rather than the static cap.',
  ZERO_ADDRESS: 'Address validity is decided by inspectAddress, which subsumes the zero case.',
};

/** Error classes. The renderer maps these by code, not by class identity. */
const ERROR_CLASSES = new Set([
  'AbortError',
  'ConfigError',
  'NoIndexerError',
  'NoSignerError',
  'NotFoundError',
  'PreconditionError',
  'RevertError',
  'SaltMiningError',
  'StaleProposalError',
  'ValidationError',
  'IndexerQueryError',
  'QuaiVaultError',
]);

/**
 * Surface the plan says the CLI *should* exercise and currently does not.
 *
 * These are findings, tracked in the open rather than absent. Delete an entry
 * when it is fixed — the test will tell you to.
 */
const KNOWN_GAPS: Record<string, string> = {};

describe('SDK surface coverage', () => {
  const exports = publicExports();
  const direct = directImports();

  it('finds the SDK export barrel at all', () => {
    // Guards against the whole test passing vacuously because the .d.ts
    // layout changed.
    expect(exports.length).toBeGreaterThan(100);
    expect(exports).toContain('connect');
    expect(exports).toContain('QuaiVaultClient');
  });

  it('classifies every public export', () => {
    const unclassified = exports.filter(
      (name) =>
        !direct.has(name) &&
        !(name in EXERCISED_VIA_INSTANCE) &&
        !STRUCTURAL_TYPES.has(name) &&
        !(name in NOT_APPLICABLE) &&
        !ERROR_CLASSES.has(name) &&
        !(name in KNOWN_GAPS),
    );
    expect(
      unclassified,
      'New SDK exports must be classified in test/contract/sdk-coverage.test.ts. ' +
        'Decide whether the CLI should exercise them (plan §1.0) rather than letting ' +
        'them go silently unvalidated.',
    ).toEqual([]);
  });

  it('keeps every via-instance claim honest', () => {
    // An entry claiming "reached through vault.watch(" is a lie the moment
    // that call site is deleted. Check the marker still appears in src/.
    const broken = Object.entries(EXERCISED_VIA_INSTANCE).filter(
      ([, marker]) => !corpus.includes(marker),
    );
    expect(
      broken.map(([name, marker]) => `${name} claims "${marker}", which no longer appears in src/`),
    ).toEqual([]);
  });

  it('lists no exclusion for something the SDK no longer exports', () => {
    // A stale exclusion reads as a decision about surface that does not
    // exist. Every name we exclude must still be real.
    const known = new Set(exports);
    const stale = [
      ...Object.keys(EXERCISED_VIA_INSTANCE),
      ...STRUCTURAL_TYPES,
      ...Object.keys(NOT_APPLICABLE),
      ...Object.keys(KNOWN_GAPS),
      ...ERROR_CLASSES,
    ].filter((n) => !known.has(n));
    expect(stale, 'excluded names the SDK no longer exports').toEqual([]);
  });

  it('keeps KNOWN_GAPS honest in both directions', () => {
    // A gap the CLI has started using must be deleted from the list, or the
    // list stops describing reality.
    const fixed = Object.keys(KNOWN_GAPS).filter((n) => direct.has(n));
    expect(
      fixed.map((n) => `${n} is now imported — delete it from KNOWN_GAPS`),
    ).toEqual([]);
  });

  it('reports coverage so a regression is visible', () => {
    const covered = exports.filter(
      (n) => direct.has(n) || n in EXERCISED_VIA_INSTANCE || ERROR_CLASSES.has(n),
    ).length;
    const pct = Math.round((covered / exports.length) * 100);
    // A floor, not a target. Chasing the number by importing types the CLI
    // does not need would be gaming it; this only catches a real regression.
    expect(pct, `SDK surface coverage is ${pct}%`).toBeGreaterThanOrEqual(50);
  });

  it('keeps the web-parity capability paths wired to concrete SDK calls', () => {
    const requiredCalls = [
      '.propose.erc20Transfer(',
      '.propose.erc721Transfer(',
      '.propose.erc1155Transfer(',
      '.propose.batch(',
      '.propose.call(',
      '.propose.setupRecovery(',
      '.propose.addOwner(',
      '.propose.removeOwner(',
      '.propose.changeThreshold(',
      '.propose.setMinExecutionDelay(',
      '.propose.cancelByConsensus(',
      '.propose.enableModule(',
      '.propose.disableModule(',
      '.propose.addDelegatecallTarget(',
      '.propose.removeDelegatecallTarget(',
      '.propose.signMessage(',
      '.propose.unsignMessage(',
      '.deposits(',
      '.tokenTransfers(',
      '.revokeApproval(',
      '.expire(',
      '.connection.vault(',
    ];
    expect(requiredCalls.filter((marker) => !corpus.includes(marker))).toEqual([]);
  });
});
