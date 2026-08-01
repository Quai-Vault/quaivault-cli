/**
 * R4 — measure the real ABI-resolution hit rate before building Phase 10.
 *
 * Plan §8 R4 and §11's one open question: "Does Phase 10 exist? Gated on the
 * R4 measurement — an afternoon's work that decides whether a 3–4 week
 * feature is worth building."
 *
 * Phase 10 answers "what does this calldata do?" for a contract the SDK ships
 * no ABI for. Its mechanism: read deployed bytecode, parse the Solidity CBOR
 * metadata trailer for an IPFS CID, fetch the metadata JSON from a gateway,
 * take `.output.abi`. Every link can be missing, and the chain is only as
 * strong as its weakest:
 *
 *   1. Is there a contract at the address at all? (an EOA has no bytecode)
 *   2. Does the bytecode carry a CBOR trailer? (--no-cbor-metadata omits it)
 *   3. Does the trailer contain an IPFS CID? (bzzr0/none are alternatives)
 *   4. Is that CID actually retrievable? Availability is per-CID, not
 *      per-gateway — R4 records one contract resolving in 148ms while another
 *      from the same deployment hung 45s.
 *
 * Measured against the contracts real mainnet proposals actually target,
 * because a hit rate measured against a curated list of verified contracts
 * would be a measurement of the list.
 *
 * Plain .mjs rather than TypeScript on purpose: running a .ts script would
 * mean adding tsx to a repo that pins every dependency exactly and audits the
 * ones it has. A measurement script is not worth a dependency.
 *
 * Read-only, keyless, publishes nothing.
 *
 *   node scripts/measure-ipfs.mjs [--limit 200] [--gateway https://…]
 */
import { connect, mainnet } from '@quaivault/sdk';
import { getAddress } from 'quais';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GATEWAY = argOf('gateway', process.env.QUAIVAULT_IPFS_GATEWAY ?? 'https://ipfs.qu.ai');
const LIMIT = Number(argOf('limit', '200'));

/** §10: "3 s hard per-attempt timeout" — the budget Phase 10 would live in. */
const ATTEMPT_TIMEOUT_MS = 3_000;

/**
 * Parse Solidity's CBOR metadata trailer.
 *
 * Layout: the last two bytes are a big-endian length; the CBOR map sits
 * immediately before them. Reimplemented rather than taking
 * `@ethereum-sourcify/bytecode-utils`, which depends on ethers 6 — a second
 * full Ethereum library in a project that already pins quais, itself an
 * ethers fork (§10, where the duplicate-library argument is called decisive).
 *
 * Only the known keys are scanned for, not a general CBOR reader: the map is
 * a handful of byte-string entries and a version, so this is both shorter and
 * harder to turn into a parser bug.
 */
function parseCborTrailer(code) {
  const hex = code.replace(/^0x/, '');
  if (hex.length < 8) return { format: 'none' };
  const declared = parseInt(hex.slice(-4), 16);
  if (!Number.isFinite(declared) || declared <= 0) return { format: 'none' };
  const start = hex.length - 4 - declared * 2;
  if (start < 0) return { format: 'none' };
  const cbor = Buffer.from(hex.slice(start, hex.length - 4), 'hex');

  for (const [key, format] of [
    ['ipfs', 'ipfs'],
    ['bzzr0', 'swarm'],
    ['bzzr1', 'swarm'],
  ]) {
    // A CBOR text key: 0x60+len, then the ASCII name.
    const marker = Buffer.concat([Buffer.from([0x60 + key.length]), Buffer.from(key, 'ascii')]);
    const at = cbor.indexOf(marker);
    if (at === -1) continue;
    let p = at + marker.length;
    const head = cbor[p];
    if (head === undefined) continue;
    let len;
    if (head === 0x58) {
      len = cbor[p + 1] ?? 0;
      p += 2;
    } else if (head >= 0x40 && head <= 0x57) {
      len = head - 0x40;
      p += 1;
    } else {
      continue;
    }
    const raw = cbor.subarray(p, p + len);
    if (raw.length !== len) continue;
    return { cid: format === 'ipfs' ? base58(raw) : raw.toString('hex'), format };
  }
  return { format: cbor.length ? 'cbor-without-ipfs' : 'none' };
}

/** Base58btc, turning the raw multihash into the CIDv0 a gateway wants. */
function base58(buf) {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of buf) {
    if (byte === 0) out += '1';
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

async function fetchCid(cid) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  try {
    const res = await fetch(`${GATEWAY}/ipfs/${cid}`, { signal: controller.signal });
    const ms = Date.now() - started;
    if (!res.ok) return { ok: false, hasAbi: false, ms, error: `HTTP ${res.status}` };
    const body = await res.json();
    return { ok: true, hasAbi: Array.isArray(body?.output?.abi), ms };
  } catch (err) {
    return { ok: false, hasAbi: false, ms: Date.now() - started, error: err?.name ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(`gateway              ${GATEWAY}`);
  console.log(`per-attempt timeout  ${ATTEMPT_TIMEOUT_MS}ms`);
  console.log(`sample limit         ${LIMIT}\n`);

  const qv = connect({ network: mainnet, useEnv: false });
  const health = await qv.indexerHealth().catch(() => null);
  console.log(`indexer              ${health?.available ? 'available' : 'UNAVAILABLE'}`);
  if (!qv.indexer) throw new Error('no indexer configured for mainnet');

  // `indexer.from()` is the SDK's documented escape hatch "for queries the
  // SDK does not wrap". There is no owner-free vault enumeration in the
  // public API, and this measurement is about the population rather than one
  // owner's vaults.
  const { data, error } = await qv.indexer
    .from('transactions')
    .select('to_address,data')
    .limit(LIMIT);
  if (error) throw new Error(`indexer query failed: ${error.message}`);

  const rows = data ?? [];
  const targets = new Set();
  let withCalldata = 0;
  for (const row of rows) {
    if (row.to_address) targets.add(String(row.to_address).toLowerCase());
    if (row.data && row.data !== '0x') withCalldata++;
  }

  console.log(`proposals sampled    ${rows.length}`);
  console.log(`  carrying calldata  ${withCalldata}  (a plain QUAI transfer needs no ABI)`);
  console.log(`unique targets       ${targets.size}\n`);

  if (targets.size === 0) {
    console.log('No proposal targets on mainnet yet. Phase 10 stays gated —');
    console.log('there is no population to measure a hit rate against.');
    return;
  }

  // Phase 10's value is only for contracts the SDK does not already decode.
  // A vault self-call, the recovery module, MultiSend and the ERC-20/721/1155
  // selectors are all `builtin` today, so resolving an ABI for them changes
  // nothing. Counting them in the hit rate would measure the SDK's own
  // deployment, not the gap Phase 10 would close.
  const known = new Map();
  for (const [name, addr] of Object.entries(mainnet.contracts)) {
    if (addr) known.set(addr.toLowerCase(), name);
  }

  const results = [];
  for (const address of targets) {
    const result = { address, hasCode: false, codeBytes: 0 };
    result.known = known.get(address) ?? null;
    if (!result.known) {
      // A vault the factory deployed is also already decodable.
      const isVault = await qv.vaults.exists(address).catch(() => false);
      if (isVault) result.known = 'vault';
    }
    try {
      // The Quai RPC rejects a non-checksummed address outright
      // (-32000 "address has invalid checksum"), and the indexer stores
      // addresses lowercased. Without this every call throws and the whole
      // measurement reads as "0% of targets are contracts" — which is what
      // it did on the first run.
      const code = await qv.provider.getCode(getAddress(address));
      result.codeBytes = Math.max(0, (code.length - 2) / 2);
      result.hasCode = result.codeBytes > 0;
      if (result.hasCode) {
        const { cid, format } = parseCborTrailer(code);
        result.format = format;
        if (cid && format === 'ipfs') {
          result.cid = cid;
          const fetched = await fetchCid(cid);
          result.fetched = fetched.ok;
          result.hasAbi = fetched.hasAbi;
          result.ms = fetched.ms;
          result.error = fetched.error;
        }
      }
    } catch (err) {
      result.error = String(err?.message ?? err).slice(0, 60);
    }
    results.push(result);
    console.log(
      `  ${result.address}  ${result.hasCode ? `${String(result.codeBytes).padStart(6)}b` : '   EOA'}` +
        `  ${(result.known ?? 'EXTERNAL').padEnd(18)}` +
        `  ${(result.format ?? '-').padEnd(10)}` +
        `  ${result.cid ? (result.hasAbi ? `ABI in ${result.ms}ms` : `miss (${result.error ?? 'no .output.abi'})`) : ''}`,
    );
  }

  const contracts = results.filter((r) => r.hasCode);
  const withCid = contracts.filter((r) => r.cid);
  const resolved = withCid.filter((r) => r.hasAbi);
  const external = contracts.filter((r) => !r.known);
  const externalResolved = external.filter((r) => r.hasAbi);
  const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);

  console.log('\n──────────────────────────────────────────────────────────────');
  console.log('R4 measurement — does Phase 10 exist?');
  console.log('──────────────────────────────────────────────────────────────');
  console.log(`targets sampled           ${results.length}`);
  console.log(`  are contracts           ${contracts.length}  (${pct(contracts.length, results.length)})`);
  console.log(`  carry an IPFS CID       ${withCid.length}  (${pct(withCid.length, contracts.length)} of contracts)`);
  console.log(`  CID resolves to an ABI  ${resolved.length}  (${pct(resolved.length, withCid.length)} of CIDs)`);
  console.log('');
  console.log(`END-TO-END HIT RATE       ${pct(resolved.length, contracts.length)} of contract targets`);
  console.log('');
  console.log('The number that decides Phase 10 — targets the SDK does NOT');
  console.log('already decode, since resolving an ABI for a vault, the factory,');
  console.log('the recovery module or MultiSend changes nothing:');
  console.log(`  external targets        ${external.length}  (${pct(external.length, contracts.length)} of contracts)`);
  console.log(`  of those, resolved      ${externalResolved.length}  (${pct(externalResolved.length, external.length)})`);
  if (resolved.length) {
    const times = resolved.map((r) => r.ms).sort((a, b) => a - b);
    console.log(
      `  latency  min ${times[0]}ms  median ${times[times.length >> 1]}ms  max ${times[times.length - 1]}ms`,
    );
  }
  console.log('');
  console.log('Decision rule (§11): Phase 10 is 3–4 weeks. A hit rate leaving most');
  console.log('proposal targets undecoded does not justify it — §7.1 already renders');
  console.log('the full raw calldata, which is a correct disclosure for "we do not know",');
  console.log('not a placeholder for a missing feature.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
