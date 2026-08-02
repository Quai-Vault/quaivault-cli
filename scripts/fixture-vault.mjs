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
 * Preflight reports whether the head is advancing but never refuses on it —
 * the head number is zone-scoped and writes land fine against a head that
 * looks static. `--skip-head-watch` skips that report; it overrides no safety
 * check, because there is none. Confirmations on Orchard are slow and the
 * full run takes many minutes.
 *
 * `--preflight` is runnable with no key at all and verifies everything that
 * does not require one: network reachable, factory registered and
 * self-consistent, indexer live. Run it first — a failed deployment halfway
 * through leaves funded junk on Orchard.
 *
 * Writes `test/e2e/fixture-vaults.json`, which the e2e suite reads.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, testnet, MAX_EXECUTION_DELAY, minimumExpiration } from '@quaivault/sdk';
import { getBytes, SigningKey, Wallet, getAddress } from 'quais';

const argv = process.argv.slice(2);
const PREFLIGHT = argv.includes('--preflight');
/** Skip the informational head watch. Overrides no safety check — there is none. */
const SKIP_HEAD_WATCH = argv.includes('--skip-head-watch') || argv.includes('--assume-live');
/**
 * Reuse the vaults in an existing fixture and only attempt the states it is
 * missing. A full run costs twenty-plus minutes of Orchard confirmations, so
 * redeploying two vaults to retry one proposal is a poor trade.
 */
const REPAIR = argv.includes('--repair');
const OUT = 'test/e2e/fixture-vaults.json';

/** The seven lifecycle states a complete fixture holds. */
const SEVEN = ['pending', 'cancelled', 'expired', 'ready', 'timelocked', 'executed', 'failed'];

/**
 * How long to watch the head before reporting on it.
 *
 * **This is a warning, not a gate, and the distinction was earned.** An
 * earlier version refused to deploy when the head had not moved. That check
 * was wrong twice over: it demanded movement inside 45s, which any chain with
 * slower blocks would fail, and — more fundamentally — it trusted a signal
 * that does not mean what it looks like. `getBlockNumber()` against Orchard
 * is zone-scoped, and `getBlock(n)` on the same head throws "Invalid shard".
 *
 * Observed 2026-08-02: the head sat at 1627459 through ten minutes of
 * continuous sampling and was unchanged from 21 hours earlier — and vault
 * creation, funding and confirmation all succeeded against that same chain
 * minutes later. A stalled head number and a working chain are not mutually
 * exclusive here, so refusing on it would block real work for a false reason.
 */
const LIVENESS_TIMEOUT_MS = Number(process.env.QUAIVAULT_LIVENESS_TIMEOUT_MS ?? 60_000);
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

/**
 * Margin above the contract's minimum expiry, for the `expired` fixture.
 *
 * The floor is **not** `now + effectiveDelay`. `_proposeTransaction` rejects
 * `expiration <= block.timestamp + effectiveDelay`, and the SDK's
 * `minimumExpiration` adds a margin on top to absorb the gap between building
 * a proposal and it being mined. An earlier version of this script hardcoded
 * `now + 90` and was rejected on chain with "expiration 1785702448 is too
 * soon … requires an expiration after 1785702780" — a 332-second shortfall.
 *
 * So the floor comes from the SDK, exactly as `qv propose` computes it, and
 * this is only the cushion added to it.
 *
 * The cushion is large because the contract checks against `block.timestamp`
 * **at mining time**, not at build time, and an Orchard confirmation takes
 * minutes. A second failure — "requires an expiration after 1785704114", 170s
 * short — came from computing this against a `now` captured 530 seconds
 * earlier, before two vault creations and two funding transfers. Always
 * compute it immediately before proposing, never from a stashed clock.
 */
const EXPIRY_MARGIN_SECONDS = 600;
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
  if (SKIP_HEAD_WATCH) {
    log('                   head watch skipped');
  } else {
    const seconds = await awaitBlock(qv);
    log(
      seconds === null
        ? `                   head did not move in ${LIVENESS_TIMEOUT_MS / 1000}s — see note below`
        : `                   head advancing, ~${seconds}s per block`,
    );
    if (seconds === null) {
      log('');
      log('A static head is NOT proof the chain is down. getBlockNumber() here is');
      log('zone-scoped and getBlock() on the same head throws "Invalid shard", so');
      log('writes can land against a head that never appears to move. Deploying is');
      log('still reasonable; expect slow confirmations.');
    }
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

  const existing =
    REPAIR && existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  if (REPAIR && !existing) {
    throw new Error(`--repair needs an existing ${OUT}; run without it first`);
  }

  const balance = await qv.provider.getBalance(me);
  if (balance === 0n) throw new Error(`${me} holds no Orchard QUAI — fund it first`);

  // No gate here. The head signal is unreliable (see LIVENESS_TIMEOUT_MS) and
  // blocking a real deployment on it would be worse than a slow one.
  log(`deploying as ${me} (${balance} wei)\n`);

  let held;
  let solo;
  if (existing) {
    held = { address: existing.vaults.held };
    solo = { address: existing.vaults.solo };
    log(`reusing held ${held.address}`);
    log(`reusing solo ${solo.address}`);
    log(`missing states: ${SEVEN.filter((k) => !existing.states[k]).join(', ') || 'none'}\n`);
  } else {
    log('creating the held vault (threshold 2, quorum unreachable)…');
    held = await qv.factory.create({ owners: [me, getAddress(CO_OWNER)], threshold: 2 });
    log(`  ${held.address}  ${held.chainTxHash}`);

    log('creating the solo vault (threshold 1, you are quorum)…');
    solo = await qv.factory.create({ owners: [me], threshold: 1 });
    log(`  ${solo.address}  ${solo.chainTxHash}\n`);
  }

  const heldVault = qv.vault(held.address);
  const soloVault = qv.vault(solo.address);
  const states = { ...(existing?.states ?? {}) };

  // Both vaults need a little balance to propose value transfers against.
  // `from` is required. Quai is sharded, so quais will not infer the
  // originating zone for a plain value transfer and throws
  // `unsupported addressable value (argument="target", value=null)` without
  // it — an error that names neither `from` nor the transaction.
  log(existing ? 'topping both vaults up…' : 'funding both vaults…');
  for (const address of [held.address, solo.address]) {
    const tx = await wallet.sendTransaction({
      from: me,
      to: address,
      value: 10_000_000_000_000_000n,
    });
    await tx.wait();
    log(`  ${address}  ${tx.hash}`);
  }

  // Each state is independent. A single failure must not discard the states
  // already created — this run costs twenty minutes of confirmations, and a
  // partial fixture is far more useful than none.
  const failures = [];
  const step = async (name, fn) => {
    if (states[name]) {
      log(`  ${name.padEnd(10)} ${states[name]}  (already present)`);
      return;
    }
    try {
      states[name] = await fn();
      log(`  ${name.padEnd(10)} ${states[name]}`);
    } catch (err) {
      failures.push(`${name}: ${err?.message ?? err}`);
      log(`  ${name.padEnd(10)} FAILED — ${String(err?.message ?? err).slice(0, 120)}`);
    }
  };

  // ---- held vault: the states that require quorum NOT to be reached -------
  log('\nheld vault:');

  await step('pending', async () => (await heldVault.propose.transfer({ to: me, amount: 1n })).txHash);

  await step('cancelled', async () => {
    const tx = await heldVault.propose.transfer({ to: me, amount: 2n });
    await heldVault.cancel(tx.txHash);
    return tx.txHash;
  });

  // Computed here, at the moment of proposing, against the live clock —
  // `minimumExpiration` with no `at` argument. Anything stashed earlier in
  // the run is already minutes stale by the time this executes.
  let expiresAt = 0;
  await step('expired', async () => {
    expiresAt = minimumExpiration(0) + EXPIRY_MARGIN_SECONDS;
    const tx = await heldVault.propose.transfer({ to: me, amount: 3n, expiration: expiresAt });
    return tx.txHash;
  });
  if (expiresAt) {
    log(`             (expires ${new Date(expiresAt * 1000).toISOString()} — run \`qv tx expire\` after)`);
  }

  // ---- solo vault: the executing paths -----------------------------------
  log('\nsolo vault:');

  await step('ready', async () => {
    const tx = await soloVault.propose.transfer({ to: me, amount: 1n });
    await soloVault.approve(tx.txHash);
    return tx.txHash;
  });

  await step('timelocked', async () => {
    const tx = await soloVault.propose.transfer({
      to: me,
      amount: 1n,
      executionDelay: TIMELOCK_SECONDS,
    });
    await soloVault.approve(tx.txHash);
    return tx.txHash;
  });

  await step('executed', async () => {
    const tx = await soloVault.propose.transfer({ to: me, amount: 1n });
    await soloVault.approve(tx.txHash);
    await soloVault.execute(tx.txHash);
    return tx.txHash;
  });

  // The inner call reverts while the chain transaction succeeds — the exact
  // case Appendix A records a shipped UI rendering as a green check.
  // An ERC-20 `transfer` aimed at a contract that has no such selector and no
  // fallback: the outer Quai transaction succeeds, the inner vault call
  // reverts.
  await step('failed', async () => {
    const tx = await soloVault.propose.erc20Transfer({
      token: testnet.contracts.socialRecovery,
      to: me,
      amount: 1n,
    });
    await soloVault.approve(tx.txHash);
    const outcome = await soloVault
      .execute(tx.txHash)
      .catch((e) => ({ outcome: 'threw', message: e.message }));
    log(`             (execute outcome: ${outcome.outcome})`);
    return tx.txHash;
  });

  const fixture = {
    network: 'testnet',
    createdAt: new Date().toISOString(),
    deployer: me,
    vaults: { held: held.address, solo: solo.address },
    states,
    notes: {
      ...(expiresAt
        ? { expired: `not expired until ${expiresAt}; run \`qv tx expire\` after that` }
        : {}),
      timelocked: `executable after ~${now + TIMELOCK_SECONDS}`,
    },
    ...(failures.length ? { failures } : {}),
  };
  writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`);
  log(`\nwrote ${OUT} — ${Object.keys(states).length} of 7 states`);
  if (failures.length) {
    log('');
    log('Some states failed. The fixture is still usable for the rest:');
    for (const f of failures) log(`  ${f}`);
    process.exitCode = 1;
  }
  log('\nRemaining manual step: after the expiry passes, run');
  log(`  qv tx expire ${held.address} ${states.expired}`);
  log('to move that proposal from pending-past-expiry into the expired state.');
}

const main = PREFLIGHT ? preflight : deploy;
main().catch((err) => {
  console.error(`\n${err.message ?? err}`);
  process.exitCode = 1;
});
