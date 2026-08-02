# Quai and quais: behaviours worth knowing before they cost you an afternoon

Everything here was **observed directly** on 2026-08-01/02 against live
mainnet and Orchard, with a funded key. Nothing is inferred from
documentation. Each entry says what it broke, because the symptom is usually
further from the cause than you would like.

PLAN.md marks verified claims `*(verified)*`; this file is the same discipline
applied to the environment rather than to the SDK.

---

## The RPC rejects non-checksummed addresses

```
-32000  address has invalid checksum
```

`quai_getCode` and friends refuse an all-lowercase address outright. The
indexer, meanwhile, **stores addresses lowercased** — so the natural pipeline
of "read an address from the indexer, hand it to the provider" fails on every
single call.

**What it broke.** The first run of `scripts/measure-ipfs.mjs` reported that
0 of 17 mainnet proposal targets were contracts, including the QuaiVault
factory. Every `getCode` was throwing into a `catch` that recorded the address
as an EOA. "0% of proposal targets are contracts" is exactly the kind of
plausible number that kills a feature on a typo — the real answer was 82%.

**What to do.** `quais.getAddress()` before any raw provider call.
`qv.vault(address)` needs no such treatment: the SDK normalises internally, so
a lowercase address on the command line works fine. This only bites code that
talks to `qv.provider` directly.

---

## `getBlockNumber()` is zone-scoped and is not a liveness signal

`getBlock(n)` on the head throws **`Invalid shard`**, which is the clue: the
number `getBlockNumber()` returns describes one zone of a sharded network, not
the network.

**Observed on Orchard**: the head sat at 1627459 through ten minutes of
continuous 30-second sampling, and was the *same* value 21 hours earlier —
while mainnet advanced normally (+29 blocks in 604 s, ~21 s each). Minutes
later, against that same unmoving head, vault creation, funding and
confirmation all succeeded and `qv vault show` read the funded balance back.

**A static head number and a working chain are not mutually exclusive here.**

**What it broke.** A liveness gate that refused to deploy when the head had
not moved. It would have blocked real work on a healthy chain. The gate is
gone; `scripts/fixture-vault.mjs` now reports head movement and says plainly
that a static head proves nothing.

---

## `sendTransaction` needs an explicit `from`

A plain value transfer built as `{ to, value }` fails with:

```
unsupported addressable value (argument="target", value=null, code=INVALID_ARGUMENT)
```

The error names neither `from` nor the transaction, which is what makes it
expensive. Quai is sharded and quais will not infer the originating zone.

**What to do.** `{ from, to, value }`. The SDK sets this for its own writes —
`factory.create()` and every `propose.*` work fine — so this only affects code
holding a raw `quais.Wallet`.

---

## quais reports the wrong version in its errors

`quais@1.0.0-alpha.56` ships a `lib/esm/_version.js` containing
`1.0.0-alpha.53`. Every error message it raises therefore names alpha.53.

Exactly one copy is installed and it is the correct one — `npm ls quais` and
CI's single-copy check both confirm it. But anyone debugging a quais error
will be sent to the wrong release notes, and may reasonably conclude the
project has a duplicate-dependency problem it does not have. Worth filing
upstream.

---

## The expiry floor is not `now + effectiveDelay`

`_proposeTransaction` rejects `expiration <= block.timestamp + effectiveDelay`,
and the SDK's `minimumExpiration` adds a **~300 s margin** on top to absorb
the gap between building a proposal and it being mined.

Observed rejection, with a vault whose effective delay is zero:

```
expiration 1785702448 is too soon: with an effective delay of 0s
the vault requires an expiration after 1785702780
```

That is +332 s over `now` for a delay of `0`.

**What it broke.** Twice. `propose.ts` originally computed the floor itself
with no margin, so an expiry one second past the delay passed local validation
and could revert on chain — while the error message told the user to "leave a
margin" that nothing enforced. Then `scripts/fixture-vault.mjs` reproduced the
same defect by hardcoding `now + 90`.

**What to do.** Always `minimumExpiration(effectiveDelay, undefined, now)`.
Never compute it. The dangerous version of this bug is not the rejection — it
is a margin slightly *larger* than the shortfall, which is accepted on chain
and then expires before it can ever execute.

---

## `IndexerHealth.chainHead` is genuinely optional

PLAN.md §2.2 says so *(verified)*; here is what it looks like in practice.
`qv status` against Orchard prints `head ?`, and `qv tx show` on an
indexer-sourced transaction prints `Proposed unknown` rather than a date —
because proposal age is derived as `(chainHead − proposedAtBlock) × ~5 s` and
there is no chainHead to derive it from.

Both branches are real and both must be handled:

| source | `proposedAt` | rendered |
|---|---|---|
| chain | a unix timestamp | `2m 15s ago   2026-08-02 20:27 UTC` |
| indexer, no chainHead | `0` | `unknown` |

Never render `0` as a date. 1 January 1970 on a signing surface is worse than
admitting you do not know.

---

## SDK writes wait on a receipt forever

`vault.approve()` and the other writes await a receipt with no timeout of
their own. A transaction that is broadcast and then dropped therefore hangs
the caller indefinitely rather than failing.

**Observed**: a `timelocked` approval hung for **91 minutes**. The account's
mempool nonce was clean (`latest` and `pending` both 6739), proving nothing
was queued, and every pre-flight read on the same vault returned in under a
second — `info()` 1044 ms, `pendingTransactions()` 580 ms, `transaction()`
305 ms, `affordances()` 242 ms. Re-issuing the identical `approve()` in a
fresh process succeeded in **28.6 s**.

So this is not a broken call; it is one dropped broadcast with nothing to
time it out. For `qv tx approve` the consequence is a command that can hang
rather than fail, which matters most for an agent with no human to notice.

**What to do.** Bound it at the call site. `scripts/fixture-vault.mjs` gives
each step a 10-minute budget (`QUAIVAULT_STEP_TIMEOUT_MS`) and moves on.
Note the caveat: a timeout does not cancel the broadcast, so the transaction
may still land afterwards.

## Orchard confirmations are slow and highly variable

Minutes per write, and not consistently so: two vault creations plus a funding
transfer completed inside 560 s on one run, while a single vault creation
exceeded 900 s on the next. Budget twenty-plus minutes for a full
seven-state fixture deployment, and do not build anything that assumes a
timeout below several minutes.

This is why `scripts/fixture-vault.mjs` isolates each state: losing four
completed states because the fifth threw is expensive when the states cost
twenty minutes to produce.
