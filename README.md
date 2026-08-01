# @quaivault/cli

Command-line client for [QuaiVault](https://quaivault.org) multisig vaults on Quai Network.

```bash
npm install -g @quaivault/cli
```

Two surfaces, one core: **one-shot commands** for people and agents, and a **TUI** for watching.

---

## Reading needs no key

No wallet, no account, no configuration. This works the moment you install:

```bash
qv vault show 0x005f2629A632962f4944d23686efDa5c160d535b
```

Then tell it who you are — still no key:

```bash
qv use --as 0x<your-address>
qv inbox        # what is waiting on you, across every vault
```

Add a key only when you want to sign:

```bash
qv key import mykey --use
```

`qv key import` reads a raw private key from your terminal, or takes an existing
Web3 Secret Storage (V3) keystore with `--keystore geth.json` — the format Pelagus,
MetaMask, Geth and ethers all export.

## The commands

```
Reading (no key required)
  qv status · qv doctor · qv inbox · qv vault show|ls|receive
  qv tx ls|history|show|wait · qv balance · qv messages · qv addr check
  qv recovery status|history

Acting on transactions
  qv tx approve · qv tx unapprove · qv tx execute · qv tx cancel · qv tx expire

Proposing changes  (every one of these asks your co-owners to act)
  qv propose transfer|token|nft|call
  qv propose add-owner|remove-owner|threshold|delay
  qv propose module|delegatecall|sign-message|cancel-by-consensus

Vaults, recovery, setup
  qv vault create · qv vault mine-salt
  qv recovery approve|execute|cancel|initiate
  qv key import|ls|use|rm|rename|change-password|export
  qv use · qv alias · qv contact · qv policy · qv watch · qv tui
```

Everything except `approve`/`execute`/`cancel`/`expire` is a **proposal**: it asks N−1
other people to act. The naming says so, because `qv owner add` would read like it adds
an owner when it actually asks two other people to.

## Before you sign

Every write prints a disclosure read **from chain**, not the indexer:

```
About to approve:
  Transfer 100 QUAI to alice
  0x8a3f9c21…7e6d

  Decoded as   verified
  To           0x001f4e8a9b0c1d2e3f405162738495a6b7c8d781  (alice)
  Value        100 QUAI
               exactly 100000000000000000000 wei
  Operation    call
  Data         (none)

  Approvals    1 of 2
    [x] 0x00a1b2…  (bob)
    [ ] 0x001f4e…  (alice)
```

**When the ABI is unknown, it shows the hex** — laid out one 32-byte word per line,
because ABI encoding is word-aligned and a padded address reads as 12 zero bytes then
20. You can pick out a recipient and an amount with no ABI at all:

```
  Data         unknown ABI — 68 bytes, showing raw calldata
               selector  0xa9059cbb
               [000]     000000000000000000000000001f4e8a9b0c1d2e3f405162738495a6b7c8d781
               [032]     0000000000000000000000000000000000000000000000056bc75e2d63100000
```

A decode the SDK cannot vouch for — a selector-shape guess, a supplied ABI, or a
delegatecall — is labelled as such and needs `--i-understand-unverified` to sign.

## For agents and automation

```bash
qv inbox --json            # structured, with affordances
qv tx show <v> <h> --json  # includes a `verify` block to assert against
qv --schema                # every command, flag and output shape
```

- **`--json` is a versioned CLI-owned schema** (`{"schema": 1, …}`). Every bigint is a
  decimal string in wei, never a number — `Number()` loses precision above 0.009 QUAI.
- **Exit codes are a contract.** `0` ok · `1` failure · `2` usage · `3` precondition or
  policy · `4` not executed (`approved_only`/`timelock_started`) · `5` declined · `130`
  interrupted. `qv tx execute` exits **non-zero when the vault call failed even though
  the chain transaction succeeded**.
- **`changed`** is `true`/`false`/`"unknown"`. Re-approving something you already
  approved is a no-op with `changed: false`, exit 0 — so a retry after a timeout is safe.
- **Assert, don't trust prose:** `--expect-data-hash`, `--expect-to`, `--expect-value`,
  `--expect-abi-source` all fail closed against re-read chain state before signing.

### Agents may sign, within a policy

Non-interactive signing requires a policy file that the caller cannot override:

```bash
qv policy init      # writes ~/.quaivault/policy.toml
```

```toml
max_value_per_approval_wei = "1000000000000000000"
max_approvals_per_hour     = 5
allow_to                   = []
deny_kinds                 = ["wallet_admin", "module_config", "recovery_setup"]
deny_delegatecall          = true
require_abi_source         = ["builtin"]
```

There is deliberately no flag to relocate it and no environment override — a bound the
caller can move is not a bound. An attended human at a terminal is not restricted by it.

**The safest agent deployment** is a UID or container that cannot read
`~/.quaivault/keys/` and has no `QUAIVAULT_PRIVATE_KEY*`. The whole read surface still
works, by construction.

## Security

- **No telemetry.** No usage analytics, no crash reporting, no phone-home. On a chain
  where addresses are public and permanent, correlating one with an IP is a
  deanonymisation primitive that cannot be walked back. `qv doctor` prints a
  paste-able report when *you* choose to share one.
- **No `--private-key`, `--password` or `--mnemonic` flag, ever.** `/proc/*/cmdline` is
  world-readable and rewriting `argv` does not change it. Keys come from a keystore,
  `--key-file`, `--key-fd`, or a terminal.
- **Quai ledger only.** QuaiVault is an EVM contract on the Quai ledger. Qi is a
  separate UTXO ledger that executes no contracts, so a Qi address can never sign,
  approve, or hold any role in a vault — and enough Qi owners brick a vault permanently.
  Every place an address is committed to a role checks **both** its zone and its ledger,
  because the two are orthogonal: `0x0081…` sits in a valid zone and is still Qi. This is
  not a gap awaiting support; it is what the ledgers are.
- **Keys are stored as Web3 Secret Storage V3** via `quais` — a decade-scrutinised
  standard, not something invented here. Files are `0600` in a `0700` directory, written
  atomically, and refused if they are symlinks or readable by others. KDF parameters are
  validated *before* derivation, which is what closes V3's unauthenticated-params gap.
- **`qv tui` never holds a key.** It renders, and delegates every signature to a spawned
  one-shot `qv` process that reads its own password. `kill -USR1` opens a V8 inspector on
  any Node process and serves a full heap read to anything on loopback; against a
  long-lived TUI that is a certainty rather than a race.
- **Terminal-escape and bidi injection** is stripped from every attacker-authored string —
  token names, revert reasons, config entries. A token can be named
  `"\x1b[2A\x1b[KAll checks passed"`.
- The CLI **refuses to run with `NODE_OPTIONS` set**, since it can inject code before
  ours runs.

Report vulnerabilities per [SECURITY.md](./SECURITY.md).

## Configuration

`~/.quaivault/config.toml` (or `$XDG_CONFIG_HOME/quaivault/`):

```toml
default_profile = "default"

[profiles.default]
network = "mainnet"      # or "testnet"
address = "0x00…"        # who you act as; no key needed
vault   = "0x00…"        # default vault

[aliases]
treasury = "0x005f…"

[contacts]                # so you can tell who signed
bob = "0x00a1…"
```

| Variable | Purpose |
|---|---|
| `QUAIVAULT_ADDRESS` | identity to act as |
| `QUAIVAULT_VAULT` | default vault |
| `QUAIVAULT_PROFILE` | profile to use |
| `QUAIVAULT_PRIVATE_KEY_FILE` | key file for CI (preferred over the next one) |
| `QUAIVAULT_PRIVATE_KEY` | raw key — supported, least preferred |
| `QUAIVAULT_KEYSTORE_PASSWORD_FILE` | keystore password for non-interactive use |

`NO_COLOR`, `FORCE_COLOR` and `--color` all work. Output to a pipe drops all chrome:
data goes to stdout, warnings and hints to stderr.

## Shell completion

```sh
qv completion bash > ~/.local/share/bash-completion/completions/qv
qv completion zsh  > ~/.zfunc/_qv         # ensure ~/.zfunc is on $fpath
qv completion fish > ~/.config/fish/completions/qv.fish
```

The script is generated from the command registry, so it never goes stale. It
is also deliberately static: it contains no vault aliases, contact names or
paths, because a completion script lives in a dotfile that ends up in backups
and dotfile repositories.

## Further reading

- [`docs/agent-contract.md`](docs/agent-contract.md) — the full
  `{exitCode, changed, retryable}` table, the `verify` block, and how to bind
  an agent to bytes rather than to prose.
- [`docs/r4-ipfs-measurement.md`](docs/r4-ipfs-measurement.md) — why on-chain
  ABI resolution is measured and deferred rather than built.
- [`SECURITY.md`](SECURITY.md) — what this tool protects against, what it does
  not, and every irreversible action with its guard.

## Development

```bash
npm run check    # typecheck + lint + test
npm run build
npm pack         # inspect the tarball before publishing
```

Requires Node 22 or later. Releases go out through npm trusted publishing (OIDC), so
there is no `NPM_TOKEN` to leak and every release carries a provenance attestation —
verify with `npm audit signatures`.

## License

MIT
