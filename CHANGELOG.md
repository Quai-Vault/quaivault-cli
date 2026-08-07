# Changelog

All notable changes to `@quaivault/cli` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
version is `0.x`, minor bumps may contain breaking changes.

## [0.5.0] — 2026-08-06

### Security

- Transaction lifecycle writes now build disclosures from the vault contract,
  fingerprint that state, acquire the signing lock, then reread and revalidate the
  exact chain transaction immediately before broadcast. Indexed state remains useful
  for discovery, never for authorizing a signature.
- Non-interactive policy checks account for decoded recipients inside token and batch
  calls, enforce the real hourly approval count from a durable journal, and explicitly
  gate direct recovery actions. Corrupt security journals fail closed.
- Proposal commands accept `--idempotency-key`. Reconciliation is repeated while the
  signer lock is held, preventing concurrent agents from broadcasting duplicate keyed
  proposals; key reuse with different inputs is refused.
- Recovery execution requires exact owner-set, threshold, and execution-time
  expectations when unattended, plus the fixed-path policy and `--yes`.

### Added

- Proposal coverage for ERC-1155, atomic JSON batches, ABI-assisted calls, and recovery
  setup; deposit/token-transfer reads; and recovery unapprove/expire lifecycle actions.
- An assets pane and forms/actions covering vault creation, the proposal family, and
  recovery workflows in the TUI.
- Versioned schema negotiation, complete JSON envelopes, binary-level JSON contract
  tests, explicit SDK capability-path coverage, and `CAPABILITIES.md`.

### Changed

- `--json` implies non-interactive operation and emits exactly one total envelope on
  stdout, including usage failures. Dry runs serialize a stable public plan.
- Every successful broadcast includes its chain transaction hash in command data and
  structured steps. Pagination and `inbox --count` report what was actually fetched.
- TUI refreshes are event-driven and coalesced, with polling as a missed-event backstop;
  subscriptions rebalance as vault membership changes, and read failures remain visible.
- `npm run check` includes the production build so binary contract tests cannot run
  against stale artifacts.

### Fixed

- `tx wait` preserves timeout/transient retryability; message rendering uses the SDK's
  actual fields; recovery initiation returns the correct recovery hash; and recovery
  actions consistently expose vault, recovery, and chain hashes.

## [0.4.0] — 2026-08-06

### Fixed

- **`qv inbox` never showed a guardian anything.** It read only
  `pendingTransactions()` and returned early when a vault had none — which is
  exactly the shape of a vault you guard but do not own. So the one thing a
  guardian exists to act on never reached the inbox, and `--count`, which a
  shell prompt reads, said zero while a recovery sat waiting. Pending
  recoveries are now read before that return, bucketed by
  `recovery.affordances()`, and shown first in their own section: to a guardian
  a recovery is the job, and to an owner it is someone replacing the entire
  owner set. `invalidatedBy` gained `recoveries`, without which a recovery
  could land and the cached inbox would not notice.

- **A failed action in the TUI reported only "refused: precondition or
  policy".** The spawned child prints the real reason to the primary screen,
  and Ink re-entered the alternate screen and redrew the instant it exited, so
  the message was gone before it could be read — and exit 3 covers everything
  from a wrong keystore password to a policy allowlist to a key that does not
  match the identity. The TUI now holds the screen after a failure until you
  press a key.

### Added

- **A `policy` pane in the TUI**, and the one-shot commands underneath it:
  `qv policy set <field> <value>`, `qv policy unset <field>`, and a `qv policy
  show` that prints the actual values rather than only the file's path. The
  pane is read-only until `e`.

  The TUI never writes the policy file. It spawns `qv policy set`, which is
  where validation and the write live — otherwise the TUI would hold a
  capability the one-shot surface lacks, and the pane could drift into a
  second, laxer implementation of the bound it displays.

  **`qv policy set` refuses without a terminal, and has no override flag.** The
  policy bounds what a non-interactive caller may sign; a non-interactive
  caller that can widen its own bound is not bounded, and an agent emits
  `--yes` as readily as it emits anything else. Provisioning a machine means
  writing the file directly, as it always did.

  The writer regenerates the commented file rather than bare keys. The comments
  are the only place the reasoning lives — why `deny_delegatecall` should stay
  true, what `builtin` means — and a tool that quietly stripped them would make
  the file less safe every time somebody changed a number.
  `require_abi_source` cannot be emptied: "sign anything, however it was
  decoded" is the opposite of a bound, and it would be reached by clearing a
  field.

- `qv inbox --json` carries `recoveries`, plus `counts.recoveriesPending` and
  `counts.recoveriesNeedingYou`.

## [0.3.1] — 2026-08-05

### Fixed

- **Roughly every second character of a typed password was swallowed.** The
  TUI erased its frame before spawning a signer but left raw mode on and its
  stdin listener attached, so Ink went on reading the same file descriptor the
  child was reading and the two processes split the byte stream between them.
  The characters the TUI won were discarded as unhandled keys. Spawning now
  goes through Ink's `suspendTerminal`, which turns raw mode off, unrefs stdin
  and detaches the listener before the child starts — so the child owns the
  terminal outright, which is what §4.4's "drops raw mode, leaves the screen,
  spawns" always meant.

- **`q` left the process running and the shell without a prompt.** Quitting
  unmounted the app but never ended the process: `@supabase/realtime-js`
  starts a heartbeat `setInterval` and opens a WebSocket, unrefs neither, and
  the SDK keeps that client private with no disconnect — so once a vault was
  being watched the event loop could not drain, and `main()` sets
  `process.exitCode` and returns rather than exiting. Ctrl-C worked only
  because the SIGINT handler calls `process.exit` outright, which is also why
  `qv watch` never showed it. Channel unsubscribes are awaited now instead of
  fired and forgotten, and `qv tui` exits deliberately when it is done.

### Changed

- The alternate screen is Ink's `alternateScreen` option rather than escape
  sequences written by hand. Ink already leaves and re-enters it around a
  suspension and restores the primary screen on unmount, including on a
  signal; the hand-rolled version could not, so a spawned signer's disclosure
  would have been printed into the buffer it was meant to be kept out of.

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
