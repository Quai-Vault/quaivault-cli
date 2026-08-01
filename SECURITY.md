# Security Policy

## Reporting

Report vulnerabilities privately via GitHub Security Advisories on this repository,
or to the address in the QuaiVault organisation profile. Please do not open a public
issue for an unpatched vulnerability.

## What this tool protects, and what it does not

**It protects against:**

- Signing something other than what you reviewed — every write re-reads chain state and
  discloses `to`, value, operation, decoded calldata, the raw selector and the decode
  provenance before asking.
- Silent misreporting — a vault call that reverted inside a successful chain transaction
  exits non-zero and says so.
- Terminal-escape and bidi injection from attacker-authored strings (token names, revert
  reasons, config entries).
- Unbounded automated signing — non-interactive signing requires a policy file the
  caller cannot override.
- Keystore parameter downgrade — KDF parameters are validated before derivation, which
  is the control that V3's unauthenticated `kdfparams` otherwise leaves open.

**Residual risk, stated plainly:**

- **Heap recovery.** `quais` stores a decrypted key as an immutable hex string and
  re-parses it on every signature. We zero the buffer we own, but those copies are not
  reachable. A memory dump of a signing process can recover the key. The mitigation is
  that a one-shot signing process lives for milliseconds — which is why `qv tui` holds no
  key and delegates instead.
- **Core dumps and swap.** Node cannot call `prctl(PR_SET_DUMPABLE, 0)` or set
  `RLIMIT_CORE` from JavaScript. Set `ulimit -c 0` and use encrypted swap if this matters
  to you.
- **`ptrace` and `/proc`.** Any process running as the same user can read this one's
  memory unless the kernel is configured otherwise (`kernel.yama.ptrace_scope`).
- **Indexer observability.** "No telemetry" means this tool sends no usage data anywhere.
  It does **not** mean your activity is unobservable: reads go to a Supabase-backed
  indexer whose logs necessarily carry vault addresses and your source IP, exactly as any
  RPC provider's would.
- **`--legacy-peer-deps`.** Installing with it bypasses the SDK's `quais` version
  allowlist silently. `qv doctor` checks the resolved version and warns.

## Irreversible actions, and what guards each one

Plan §8 R8. Every action here is one you cannot undo by re-running the tool.
The guard is stated so you can check it rather than trust it, and the shape of
the friction is deliberate: **defensive actions are cheap, destructive ones are
expensive.** Appendix A records a UI that had this exactly inverted —
executing a recovery, which replaces the entire owner set, fired on one
unguarded click, while the owners' *defensive* cancel was the only guarded
action.

| Action | What it destroys | Guard |
|---|---|---|
| `qv key rm <name>` | A signing seat. If this was your only key for a vault, your access to it. | Typed confirmation of the key's **full address**, not `y/N`. Refuses non-interactively. |
| `qv key change-password` | The old password. A forgotten new one is unrecoverable. | Double entry, ≥12 characters, and a loud warning that no recovery exists. Atomic write, so a crash leaves the old keystore intact. |
| `qv key import --use` | Nothing directly, but silently changes which key signs next. | The unlocked key's address is checked against the configured identity before any signature; a mismatch is a hard error, not a warning. |
| `qv tx approve` | Nothing on its own — but it can be the approval that meets quorum. | Full §7 disclosure from chain, plus the `--i-understand-unverified` gate whenever the decode is not `builtin`, the batch contains a delegatecall, or a decode failed. |
| `qv tx execute` | Moves funds or changes vault configuration. Terminal either way: a reverted inner call still marks the transaction executed permanently. | Same disclosure and gate. All four outcomes render distinctly and exit distinctly. |
| `qv tx cancel` | The proposal. Co-signers' approvals are discarded. | Confirmation; proposer-only on chain. |
| `qv propose delegatecall` | Adds a target that can rewrite vault storage when batched. | Requires quorum like any proposal, and every co-signer sees the delegatecall disclosure before approving. |
| `qv recovery execute` | **The entire owner set.** The most destructive action in the system. | Typing the vault alias verbatim. Nothing else in the CLI asks for this. |
| `qv recovery cancel` | Nothing — it is the defensive action. | The standard `y/N` and **nothing more**, deliberately: no typed confirmation, unlike `execute`. An owner stopping a hostile recovery should not be slowed down. |
| `qv vault create` | Nothing, but spends gas and the mined salt is not reusable. | Full parameter disclosure before broadcast; `--salt-file` refuses a mismatch against the recorded create parameters. |

Two things that are **not** guarded, because a guard would be theatre:

- **Sending to a Qi-ledger address.** Unrecoverable, and `qv addr check` and every
  propose path refuse it outright rather than confirming it. A refusal is the
  correct guard; a prompt is not.
- **`--yes` on a read.** Reads change nothing.

## Cryptography

None is invented here. Key storage is Web3 Secret Storage V3 via `quais`
(scrypt N=2¹⁷ → AES-128-CTR → keccak MAC); password input is `@inquirer/password`.
Keystores below N=2¹⁷ are refused unless `--accept-weak-kdf` is passed; above N=2²⁰
they are refused outright, since a tampered file could otherwise force ~1 GiB and an
unbounded CPU burn.

## Supported versions

The latest published minor. This is pre-1.0 software.
