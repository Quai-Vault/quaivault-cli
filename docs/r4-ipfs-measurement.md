# R4 — the IPFS hit-rate measurement, and what it says about Phase 10

**Measured 2026-08-01** against Quai mainnet, gateway `https://ipfs.qu.ai`, 3 s
per-attempt timeout. Reproduce with:

```
node scripts/measure-ipfs.mjs --limit 300
```

PLAN.md §11 lists one open question: *"Does Phase 10 exist? Gated on the R4
measurement — an afternoon's work that decides whether a 3–4 week feature is
worth building."* This is that afternoon.

## What was measured

Phase 10 answers "what does this calldata do?" for a contract the SDK ships no
ABI for. The mechanism has four links, and it is only as strong as the weakest:

1. Is there a contract at the address at all?
2. Does its bytecode carry a Solidity CBOR metadata trailer?
3. Does that trailer contain an IPFS CID rather than `bzzr0`/nothing?
4. Is the CID actually retrievable inside the timeout budget?

Measured against the contracts **real mainnet proposals actually target**. A hit
rate measured against a curated list of verified contracts would be a
measurement of the list.

## Results

The sample is the entire mainnet proposal history at time of measurement, not a
subset — a `--limit 300` query returned 141 rows.

| | count | |
|---|---:|---|
| proposals sampled | 141 | |
| carrying calldata | 82 | a plain QUAI transfer needs no ABI |
| unique target addresses | 17 | |
| are contracts | 14 | 82% |
| carry an IPFS CID | **14** | **100% of contracts** |
| CID resolves to an ABI | 13 | 93% of CIDs |

Latency for a hit: **min 38 ms, median 41 ms, max 132 ms** — two orders of
magnitude inside the 3 s budget §10 specifies.

### The number that actually decides it

Resolving an ABI for a vault, the factory, the recovery module or MultiSend
changes nothing: those are `abiSource: 'builtin'` today. Phase 10's value is
only for contracts the SDK does **not** already decode.

| | count | |
|---|---:|---|
| external targets | **3** | 21% of contracts |
| of those, resolved | **3** | **100%** |

Nine of the fourteen contracts are 353-byte vault proxies. One is the factory,
one the social-recovery module.

## What this changes

**R4's premise does not survive contact with the data.** The risk as written was
*"IPFS unreliability… availability is per-CID, not per-gateway: one contract
resolved in 148 ms while another from the same deployment hung 45 s."* On this
population the gateway resolved 13 of 14 CIDs with a median of 41 ms. CID
*presence* was 100% — every single contract targeted by a mainnet proposal
carries an IPFS CID in its bytecode. The technical gate passes decisively.

**The demand gate does not.** Three external contracts, across every proposal
mainnet has ever seen. Building 3–4 weeks of resolver, proxy-following, disk
cache and trust-gradient machinery to decode three addresses is not a good
trade, and §7.1 already renders their full calldata word-by-word — which is a
*correct* disclosure for "we do not know", not a placeholder.

### Recommendation

**Do not build Phase 10 as scoped. Revisit when external targets grow.**

Two things follow from the measurement rather than from the original plan:

- **A much smaller version is now obviously correct.** Because CID presence is
  100% and resolution is ~40 ms, a resolver that fires *only* when
  `abiSource === 'none'`, with the negative cache and 3 s timeout §10 already
  specifies, would have covered 100% of today's external targets. That is days,
  not weeks — the proxy-following, NFT metadata and gateway-configuration
  surface is what makes Phase 10 a month.
- **The trust-gradient requirement stands regardless.** §10 is explicit that a
  `supplied` decode with no side-map entry is a bug and must render as
  untrusted. Nothing here softens that; a fast, reliable gateway is still a
  third party, and CID verification against the raw block is still mandatory.

### One finding worth passing to the Quai team

The single miss was **the QuaiVault factory itself**
(`0x003613aC5FFd45bFF7B2F0210DA2fF660908c488`), which timed out at 3 s. Its
bytecode carries a valid IPFS CID; the content is simply not pinned on
`ipfs.qu.ai`. The social-recovery module at the same deployment resolved in
40 ms. Pinning the factory's metadata is a one-line fix that would take the
observed rate to 14/14.

`ipfs.quai.network` remains **NXDOMAIN**, confirming §10's note. Do not
configure it.

## Method notes

- The first run reported a 0% hit rate. That was an artefact: the Quai RPC
  rejects non-checksummed addresses outright (`-32000 "address has invalid
  checksum"`), the indexer stores addresses lowercased, and every `getCode`
  call was throwing into a `catch` that recorded the address as an EOA. The
  script now checksums via `quais.getAddress` before any provider call. Worth
  recording because "0% of proposal targets are contracts" is exactly the kind
  of plausible-looking number that would have killed a feature on a typo.
  (The CLI itself is unaffected — `qv.vault()` normalizes internally, so a
  lowercase address on the command line works.)
- The CBOR trailer parse is ~40 lines, reimplemented rather than taking
  `@ethereum-sourcify/bytecode-utils`, which depends on ethers 6 — a second
  full Ethereum library alongside quais, itself an ethers fork (§10).
- The script is plain `.mjs` so it needs no `tsx`: a measurement script is not
  worth a dependency in a repo that pins everything exactly.
