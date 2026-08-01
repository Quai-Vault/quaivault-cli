# Changelog

All notable changes to `@quaivault/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

### Added

- **Batch disclosure recursion** (§7). Every sub-call of a MultiSend batch is
  now disclosed with its own recipient, value, decode provenance and — when
  the ABI is unknown — full raw calldata. `--json` carries the same data, and
  every sub-call summary joins the `untrusted` pointer list.
- **`qv completion bash|zsh|fish`**, generated from the command registry and
  deliberately static: it never bakes your aliases or contacts into a dotfile.
- **`ResultStore` + `ChangeFeed`**, so `qv tui` follows `watchVault` instead of
  only refreshing when you press `r`.
- **Channel budget** reported by `qv doctor` and in the TUI status line —
  Realtime caps concurrent channels, and a screen that looks live but is not is
  worse than one that says so.
- **`qv doctor` env report** — which `QUAIVAULT_*` variables are set, by name
  only, never by value.
- `docs/agent-contract.md`, the full `{exitCode, changed, retryable}` table.
- `docs/r4-ipfs-measurement.md` and `scripts/measure-ipfs.mjs`.
- An irreversible-action table in `SECURITY.md`.

### Fixed

- **The delegatecall gate never fired.** `isDelegatecall` read an `operation`
  field that no `VaultTransaction` has ever carried, so it returned `false` for
  every transaction and the disclosure printed `Operation: call`
  unconditionally. A delegatecall can only exist inside a MultiSend payload, so
  the fix and the batch-recursion feature above are one change.
- **A batch payload the SDK's decoder silently truncates is now refused.**
  `decodeMultiSendPayload` drops a malformed entry, an overrunning length field
  and trailing bytes without erroring, any of which means the bytes the vault
  hands to MultiSend are not the bytes we described. The payload is now
  accounted for byte-exactly and a remainder fails closed.
- **`verify.dataHash` was `null`** in `qv tx show --json`, which is the value
  `--expect-data-hash` compares against.
- **Expiration validation** now uses the SDK's `minimumExpiration` rather than
  recomputing the floor locally, which also applies the block-time margin the
  error message already told users to leave.
- `qv tx approve` and `qv propose *` now report indexer lag after a successful
  write instead of swallowing it, matching `qv tx execute`.

## [0.1.0]

First release. Built against `@quaivault/sdk` 0.6.0, pinned exactly.

### Added

- **Keyless read surface** — `status`, `doctor`, `inbox` (cross-vault, urgency-ordered),
  `vault show/ls/receive`, `tx ls/history/show/wait`, `balance`, `messages`,
  `addr check`, `recovery status/history`. None of these need a key: `affordances()`
  takes a plain address, so "what is waiting on me" is a read.
- **Pre-signature disclosure** on every write, read from chain rather than the indexer,
  including the decode provenance and — when the ABI is unknown — the full raw calldata
  laid out one 32-byte word per line.
- **Transaction lifecycle** — `tx approve/unapprove/execute/cancel/expire`, with all four
  `ExecuteOutcome` values rendered distinctly and mapped to distinct exit codes.
- **Proposals** — the full `propose.*` surface, named `qv propose <thing>` to match what
  they actually do.
- **Vault creation** with CREATE2 salt mining; `mine-salt --out` records the create
  parameters alongside the salt, and `create --salt-file` refuses a mismatch.
- **Social recovery**, with friction deliberately inverted relative to the pattern it
  replaces: `execute` takes a typed confirmation, `cancel` takes none.
- **Keys** — V3 keystore via `quais`, `@inquirer/password` for input, an advisory
  signing lock against nonce collisions, and no flag that could put a secret in `argv`.
- **Agent contract** — `--json` versioned schema, `changed`/`retryable`/`steps`,
  `qv --schema` introspection, `--expect-*` assertion flags, and a policy file bounding
  non-interactive signing.
- **`qv watch`** event stream, and **`qv tui`**, which holds no key and delegates every
  signature to a spawned one-shot process.
