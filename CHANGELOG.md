# Changelog

All notable changes to `@quaivault/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [Unreleased]

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
