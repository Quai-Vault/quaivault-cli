# Changelog

All notable changes to `@quaivault/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [0.3.0] — 2026-08-05

### Fixed

- **Pasting into the propose form did nothing.** Ink delivers a paste as a
  single multi-character `input`, and `mapKey` admitted single characters
  only — so every paste mapped to `null` and was dropped, while typing worked.
  Nobody types a 42-character address, which made the form close to unusable.
  Pasting now goes through Ink's `usePaste`, which enables bracketed-paste mode
  so the terminal frames the text; a fallback still catches terminals without
  it.

  Pasted text is stripped of control and format characters before it reaches a
  field. A copied address usually carries a trailing newline and `return` on
  the last field is the submit gesture, so a paste that kept its newline could
  submit a form still being filled in; zero-width and bidirectional-override
  characters are dropped for the same reason an address must render as what it
  is. A paste past 128 characters is refused rather than truncated — a silently
  shortened address is still a plausible-looking address.

### Added

- **`propose delay` and `propose delegatecall` in the TUI form.** Both already
  existed as one-shot commands; the form offered four kinds and now offers six,
  so the vault minimum timelock and the DelegateCall whitelist can be proposed
  without leaving the TUI. The kind selector wraps, having outgrown one
  80-column line.

  Whitelisting a DelegateCall target lets it rewrite vault storage, and the
  one-shot command refuses without `--i-understand-unverified`. The form does
  **not** supply that flag on your behalf: there is an `acknowledge` field you
  type `i-understand` into, in the same spirit as the typed address `qv key rm`
  asks for. Removing a target narrows the whitelist and needs no second gate.

## [0.2.0] — 2026-08-05

### Added

- **A vault cursor in the TUI — `[` and `]`.** Four of the six panes (history,
  vault, recovery, and the propose form) are scoped to one vault, and there was
  no way to change which one: `refresh` read `vaults[0]` and `selectedVault`
  was initialised to `0` and never moved. With more than one vault only the
  inbox was genuinely multi-vault, and `qv propose` from the form built against
  whichever vault the indexer happened to return first.
- **`qv tui` takes the whole terminal**, on the alternate screen buffer, the
  way `htop` and `less` do, and gives it back untouched on exit. It steps *out*
  of the alternate buffer before spawning a signer and back in afterwards, so
  the child's §7 disclosure lands in real scrollback — the record of what you
  approved should outlive the next redraw.
- **Recovery approve and execute in the TUI** (`a` and `x` on the recovery
  pane). The pane bound only `c` (cancel), so a guardian could watch a recovery
  it could not approve. A guardian may own nothing, and therefore has no rows
  in the transaction list where those keys otherwise live.
- **Tables.** Column headers on the inbox, history and activity panes; the
  content in a bordered region distinct from the menu; the active tab in
  reverse video rather than colour alone, which `dimColor`-ignoring terminals
  rendered identically to every other tab.

### Fixed

- **The TUI vault cursor followed an index through a reordering list.**
  `loadVaults` returns owned-then-guardian in indexer order, so a vault
  appearing or disappearing shifted every index after it and moved the cursor
  onto a *different vault* — which the propose form would then build against.
  It now follows the vault address across refreshes, the same way the
  transaction cursor follows a hash.
- **A refresh reset the vault-scoped panes to the first vault.** Refresh runs
  on every chain event, so on a busy vault set the panes could not be kept on
  the vault being looked at.
- **Inbox rows wrapped when a transaction was decoded heuristically.** The
  provenance badge `guessed from selector` is 21 columns and the layout
  reserved 10, so the row ran past the edge onto a second line — which
  desynchronizes the rendered list from the viewport and pushes a transaction
  off the bottom of a fixed-height screen. A test now pins the reserve to the
  longest badge.

## [0.1.1] — 2026-08-05

No functional changes. `0.1.0` was published by hand because npm requires a
package to exist before a trusted publisher can be configured for it; this
release exists to prove the tag-triggered path in `.github/workflows/release.yml`
publishes via OIDC, with provenance and without a long-lived token. The tree is
identical to `v0.1.0` apart from the version and this entry.

## [0.1.0] — 2026-08-03

First release. Built against `@quaivault/sdk` 0.6.0, pinned exactly.

### Added

- **A multi-pane TUI on `ink`** — inbox, history, activity, vault, recovery
  and a proposal form, with tab cycling, real resize handling and width-aware
  layout. It still holds no key: every action spawns a one-shot `qv …` child
  that reads its own password and shows its own pre-signature disclosure.
  Ink is behind a dynamic import so `qv inbox` never loads React.
- **A proposal form** that builds *arguments*, never calldata. The child
  re-reads chain state and renders the §7 disclosure before anything is
  signed, so the form cannot produce a signature over bytes nobody saw.
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
- **The TUI now handles terminal resize.** The reducer has always had a
  `resize` event and nothing ever emitted it, so the viewport was fixed at
  whatever the terminal was on launch.
- **The spawned signer's output is no longer hidden.** stdout was piped while
  stdin was inherited, so the child's disclosure and its confirmation prompt
  were invisible while it waited for an answer.
- **`qv key rm` refused the address it had just printed.** `key import`
  reports a checksummed address and the confirmation compared it
  case-sensitively against the stored lowercase form, so pasting back what the
  tool showed you was rejected. EIP-55 casing is a checksum, not identity.
  Vault-alias confirmations stay case-sensitive, since two aliases can differ
  only by case.
- **The TUI cursor followed a row index through a reordering list.** The inbox
  was assembled by pushing from inside `Promise.all`, so its order depended on
  which vault's reads resolved first and changed between refreshes — meaning
  the row under the cursor could become a different transaction between
  looking at it and pressing `a`. The inbox now has a total order (fewest
  approvals needed, ties broken by hash) and the cursor follows the selected
  transaction's hash across refreshes.

### Also in this release

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
