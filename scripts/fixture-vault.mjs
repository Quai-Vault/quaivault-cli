/**
 * Stand up the Orchard fixture vaults (plan Phase 2).
 *
 * Phase 2's exit criterion: *"fixture vault holds a proposal in every
 * lifecycle state, recreatable by script."* This is the script.
 *
 * ## Why two vaults rather than one
 *
 * The seven `TransactionStatus` values split cleanly by threshold, and trying
 * to get all of them from one vault means the script has to own a second
 * signing key — more key-handling code in a wallet repo, to save a deployment.
 *
 *   **held** (threshold 2, owners = you + a second address you do not control)
 *     Nothing you propose can ever reach quorum, so proposals sit in the
 *     states that need a proposal *not* to execute:
 *       pending    — proposed, one approval, quorum never reached
 *       cancelled  — proposed then cancelled by the proposer
 *       expired    — proposed with a short expiry, then expired past it
 *
 *   **solo** (threshold 1, owner = you)
 *     You are quorum, so every executing path is reachable alone:
 *       ready            — approved, no timelock, waiting on execute
 *       timelocked       — approved with an execution delay still running
 *       executed         — approved and executed
 *       failed           — executed, and the inner call reverted
 *
 * `failed` is the one worth being deliberate about: it proposes an ERC-20
 * `transfer` from a vault holding none of that token, so the chain
 * transaction succeeds and the vault call reverts. That is precisely the
 * case Appendix A records a shipped UI rendering as a green check.
 *
 * ## Running it
 *
 * Needs a funded Orchard key. Per §3.5 there is deliberately no
 * `--private-key` flag anywhere in this project, including here:
 *
 *   export QUAIVAULT_PRIVATE_KEY_FILE=/path/to/key   # 0600, hex, no newline
 *   node scripts/fixture-vault.mjs --preflight       # checks, deploys nothing
 *   node scripts/fixture-vault.mjs
 *
 * Both wait for one block before doing anything, so a stalled chain is caught
 * before a half-finished deployment rather than after. `--assume-live` skips
 * that when you know the chain is merely slow; QUAIVAULT_LIVENESS_TIMEOUT_MS
 * raises the patience instead of removing the check.
 *
 * `--preflight` is runnable with no key at all and verifies everything that
 * does not require one: network reachable, factory registered and
 * self-consistent, indexer live. Run it first — a failed deployment halfway
 * through leaves funded junk on Orchard.
 *
 * Writes `test/e2e/fixture-vaults.json`, which the e2e suite reads.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, testnet, MAX_EXECUTION_DELAY } from '@quaivault/sdk';
import { getBytes, SigningKey, Wallet, getAddress } from 'quais';

const argv = process.argv.slice(2);
const PREFLIGHT = argv.includes('--preflight');
const ASSUME_LIVE = argv.includes('--assume-live');
const OUT = 'test/e2e/fixture-vaults.json';

/**
 * How long to wait for a single block before giving up.
 *
 * Generous on purpose. A short window conflates "stalled" with "slower than
 * my patience", and a testnet is entitled to be slow — an earlier version of
 * this check demanded movement within 45s, which would refuse to deploy on
 * any chain whose block time exceeds that. All we actually need to know is
 * whether a transaction will ever be mined, so waiting minutes is fine; the
 * deployment itself takes longer than this.
 */
const LIVENESS_TIMEOUT_MS = Number(process.env.QUAIVAULT_LIVENESS_TIMEOUT_MS ?? 300_000);
const LIVENESS_POLL_MS = 15_000;

/**
 * Wait for the head to advance by one block. Returns the observed seconds, or
 * `null` if nothing was mined within the timeout.
 *
 * Reports progress deliberately: a silent five-minute wait is
 * indistinguishable from a hang, which is the confusion this exists to end.
 */
async function awaitBlock(qv) {
  const start = await qv.provider.getBlockNumber();
  const t0 = Date.now();
  while (Date.now() - t0 < LIVENESS_TIMEOUT_MS) {
    const waited = Math.round((Date.now() - t0) / 1000);
    process.stdout.write(`\r  waiting for a block (head ${start}, ${waited}s)…    `);
    await new Promise((r) => setTimeout(r, LIVENESS_POLL_MS));
    const now = await qv.provider.getBlockNumber().catch(() => start);
    if (now > start) {
      const took = Math.round((Date.now() - t0) / 1000);
      process.stdout.write(`\r  block ${now} mined after ${took}s${' '.repeat(24)}\n`);
      return took;
    }
  }
  process.stdout.write('\r' + ' '.repeat(72) + '\r');
  return null;
}

/** A well-formed Quai address nobody holds the key to, for the held vault. */
const CO_OWNER = '0x0071111111111111111111111111111111111111';

/** Short enough to expire during the run, long enough to propose against. */
const SHORT_EXPIRY_SECONDS = 90;
/** Long enough that `timelocked` is still timelocked when the script ends. */
const TIMELOCK_SECONDS = 3600;

function log(...args) {
  console.log(...args);
}

/**
 * Build the signer from bytes (§3.5), never `connect({ privateKey })`.
 *
 * Note the class: quais exports `Wallet`, not `BaseWallet` as §3.5 writes it.
 * src/keys/signer.ts uses `Wallet` for the same reason, and this mirrors it
 * so the fixture path and the product path construct signers identically.
 */
function loadSigner(provider) {
  const path = process.env.QUAIVAULT_PRIVATE_KEY_FILE;
  if (!path) {
    throw new Error(
      'Set QUAIVAULT_PRIVATE_KEY_FILE to a file holding a funded Orchard key.\n' +
        'There is no --private-key flag: /proc/*/cmdline is world-readable (§3.5).',
    );
  }
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${path} does not contain a 32-byte hex private key`);
  }
  return new Wallet(new SigningKey(getBytes(hex)), provider);
}

async function preflight() {
  log('preflight — deploying nothing\n');
  const qv = connect({ network: testnet, useEnv: false });

  const health = await qv.indexerHealth().catch((e) => ({ available: false, error: e.message }));
  log(`indexer            ${health.available ? 'available' : `UNAVAILABLE (${health.error ?? '?'})`}`);

  // **Liveness, not just reachability.** A stalled chain answers every read
  // perfectly and mines nothing, so `create()` broadcasts and then waits on a
  // receipt that never arrives — hanging this script partway through a
  // seven-step deployment with vaults half-created. Observed on Orchard
  // 2026-08-02: head stuck at 1627459 for over 21 hours while mainnet
  // advanced normally. Reachability checks cannot see it.
  log(`orchard rpc        block ${await qv.provider.getBlockNumber()}`);
  if (ASSUME_LIVE) {
    log('                   liveness check skipped (--assume-live)');
  } else {
    const seconds = await awaitBlock(qv);
    if (seconds === null) {
      log('');
      log(`No block was mined in ${LIVENESS_TIMEOUT_MS / 1000}s. Refusing to deploy: every`);
      log('write would broadcast and then wait on a receipt that may never come,');
      log('leaving vaults half-created.');
      log('');
      log('If the chain is merely slow rather than stalled, re-run with --assume-live,');
      log('or raise QUAIVAULT_LIVENESS_TIMEOUT_MS to wait longer.');
      process.exitCode = 1;
      return;
    }
    log(`                   liveness ok, ~${seconds}s for a block`);
  }

  const verify = await qv.factory.verify();
  log(`factory            ${verify.valid ? 'consistent' : `INVALID: ${verify.errors.join('; ')}`}`);
  log(`  address          ${qv.factory.address}`);
  log(`  implementation   ${await qv.factory.implementation()}`);
  log(`  vaults deployed  ${await qv.factory.vaultCount()}`);

  log(`co-owner address   ${getAddress(CO_OWNER)}  (held vault, key held by nobody)`);
  log(`max timelock       ${MAX_EXECUTION_DELAY}s`);

  const keyPath = process.env.QUAIVAULT_PRIVATE_KEY_FILE;
  if (!keyPath) {
    log('\nkey                not configured — set QUAIVAULT_PRIVATE_KEY_FILE to deploy');
    log('                   (preflight itself needs no key)');
    return;
  }
  const wallet = loadSigner(qv.provider);
  const balance = await qv.provider.getBalance(wallet.address);
  log(`\nkey                ${wallet.address}`);
  log(`balance            ${balance} wei`);
  if (balance === 0n) {
    log('\nRefusing to deploy from an unfunded address. Fund it on Orchard first.');
    process.exitCode = 1;
  }
}

async function deploy() {
  const readOnly = connect({ network: testnet, useEnv: false });
  const wallet = loadSigner(readOnly.provider);
  const qv = connect({ network: testnet, useEnv: false, signer: wallet });
  const me = wallet.address;

  const balance = await qv.provider.getBalance(me);
  if (balance === 0n) throw new Error(`${me} holds no Orchard QUAI — fund it first`);

  // The same liveness gate as --preflight. A caller who skipped preflight
  // must not be able to start a multi-step deployment into a stalled chain.
  if (!ASSUME_LIVE && (await awaitBlock(qv)) === null) {
    throw new Error(
      `no block mined in ${LIVENESS_TIMEOUT_MS / 1000}s — every write would wait on a receipt ` +
        'that may never come. Re-run with --assume-live if the chain is merely slow.',
    );
  }
  log(`deploying as ${me} (${balance} wei)\n`);

  log('creating the held vault (threshold 2, quorum unreachable)…');
  const held = await qv.factory.create({ owners: [me, getAddress(CO_OWNER)], threshold: 2 });
  log(`  ${held.address}  ${held.chainTxHash}`);

  log('creating the solo vault (threshold 1, you are quorum)…');
  const solo = await qv.factory.create({ owners: [me], threshold: 1 });
  log(`  ${solo.address}  ${solo.chainTxHash}\n`);

  const heldVault = qv.vault(held.address);
  const soloVault = qv.vault(solo.address);
  const states = {};

  // Both vaults need a little balance to propose value transfers against.
  log('funding both vaults…');
  for (const address of [held.address, solo.address]) {
    const tx = await wallet.sendTransaction({ to: address, value: 10_000_000_000_000_000n });
    await tx.wait();
  }

  const now = Math.floor(Date.now() / 1000);

  // ---- held vault: the states that require quorum NOT to be reached -------
  log('\nheld vault:');

  const pending = await heldVault.propose.transfer({ to: me, amount: 1n });
  states.pending = pending.txHash;
  log(`  pending    ${states.pending}`);

  const toCancel = await heldVault.propose.transfer({ to: me, amount: 2n });
  await heldVault.cancel(toCancel.txHash);
  states.cancelled = toCancel.txHash;
  log(`  cancelled  ${states.cancelled}`);

  // ProposeOptions is merged into the params object, not a second argument.
  const toExpire = await heldVault.propose.transfer({
    to: me,
    amount: 3n,
    expiration: now + SHORT_EXPIRY_SECONDS,
  });
  states.expired = toExpire.txHash;
  log(`  expiring   ${states.expired}  (expire it after ${SHORT_EXPIRY_SECONDS}s)`);

  // ---- solo vault: the executing paths -----------------------------------
  log('\nsolo vault:');

  const ready = await soloVault.propose.transfer({ to: me, amount: 1n });
  await soloVault.approve(ready.txHash);
  states.ready = ready.txHash;
  log(`  ready      ${states.ready}`);

  const timelocked = await soloVault.propose.transfer({
    to: me,
    amount: 1n,
    executionDelay: TIMELOCK_SECONDS,
  });
  await soloVault.approve(timelocked.txHash);
  states.timelocked = timelocked.txHash;
  log(`  timelocked ${states.timelocked}  (executable in ${TIMELOCK_SECONDS}s)`);

  const executed = await soloVault.propose.transfer({ to: me, amount: 1n });
  await soloVault.approve(executed.txHash);
  await soloVault.execute(executed.txHash);
  states.executed = executed.txHash;
  log(`  executed   ${states.executed}`);

  // The inner call reverts while the chain transaction succeeds — the exact
  // case Appendix A records a shipped UI rendering as a green check.
  // An ERC-20 `transfer` aimed at a contract that has no such selector and no
  // fallback: the outer Quai transaction succeeds, the inner vault call
  // reverts.
  const failing = await soloVault.propose.erc20Transfer({
    token: testnet.contracts.socialRecovery,
    to: me,
    amount: 1n,
  });
  await soloVault.approve(failing.txHash);
  const outcome = await soloVault.execute(failing.txHash).catch((e) => ({
    outcome: 'threw',
    message: e.message,
  }));
  states.failed = failing.txHash;
  log(`  failed     ${states.failed}  (outcome: ${outcome.outcome})`);

  const fixture = {
    network: 'testnet',
    createdAt: new Date().toISOString(),
    deployer: me,
    vaults: { held: held.address, solo: solo.address },
    states,
    notes: {
      expired: `not expired until ${now + SHORT_EXPIRY_SECONDS}; run \`qv tx expire\` after that`,
      timelocked: `executable after ~${now + TIMELOCK_SECONDS}`,
    },
  };
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  log(`\nwrote ${OUT}`);
  log('\nRemaining manual step: after the expiry passes, run');
  log(`  qv tx expire ${held.address} ${states.expired}`);
  log('to move that proposal from pending-past-expiry into the expired state.');
}

const main = PREFLIGHT ? preflight : deploy;
main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exitCode = 1;
});
