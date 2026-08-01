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

## Cryptography

None is invented here. Key storage is Web3 Secret Storage V3 via `quais`
(scrypt N=2¹⁷ → AES-128-CTR → keccak MAC); password input is `@inquirer/password`.
Keystores below N=2¹⁷ are refused unless `--accept-weak-kdf` is passed; above N=2²⁰
they are refused outright, since a tampered file could otherwise force ~1 GiB and an
unbounded CPU burn.

## Supported versions

The latest published minor. This is pre-1.0 software.
