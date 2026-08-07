# QuaiVault CLI capability contract

This is the current product contract. `PLAN.md` remains the architectural design record.

## Surface rules

- Every capability has a one-shot command before it is exposed in the TUI.
- `--json` is non-interactive and emits exactly one versioned envelope. It never grants authority;
  writes still require `--yes`, a fixed-path policy, and applicable expectation flags.
- The TUI holds no key. Every write is delegated to a fresh one-shot process.
- Indexed data is for discovery and history. Data authorizing a signature is reread from chain.
- Browser chrome is not a parity target. Vault, asset, proposal, lifecycle, history, and recovery
  workflows are.

## Capability matrix

| Capability | One-shot | TUI |
|---|---|---|
| Vault discovery/detail/receive | `vault ls/show/receive` | inbox, vault panes |
| Vault creation | `vault create` | create-vault form |
| Native/ERC-20/ERC-721/ERC-1155 proposals | `propose transfer/token/nft/erc1155` | proposal forms |
| Raw and ABI-assisted calls | `propose call` | raw-call form; ABI workflow remains one-shot |
| Atomic batches | `propose batch --request` | batch request form |
| Owner/threshold/timelock/module/delegatecall administration | `propose *` | proposal forms |
| EIP-1271 sign/unsign | `propose sign-message [--unsign]` | proposal form |
| Social recovery setup | `propose setup-recovery` | proposal form |
| Recovery initiate/approve/unapprove/execute/cancel/expire | `recovery *` | initiate form and contextual actions |
| Native/token/NFT holdings | `balance --nfts` | assets pane |
| Transaction/recovery/deposit/token-transfer history | `tx history`, `recovery history`, `activity *` | history and activity panes |
| Transaction approve/unapprove/execute/cancel/expire | `tx *` | contextual actions |
| Key, alias, contact, policy, diagnostics | one-shot | policy where appropriate; secret-bearing key operations intentionally excluded |

## Release gates

1. Typecheck, lint, unit, contract, renderer, and binary JSON tests pass.
2. Every chain broadcast is returned as `chainTxHash` in `data` and `steps`.
3. Every unattended write is policy-bound and retry-safe for already-completed actions.
4. TUI read failures remain errors or stale data; they never become false empty states.
5. Realtime events refresh the screen and the polling tail covers unsubscribed vaults.
6. The release tag exactly matches `package.json`; GitHub Actions publishes with npm OIDC.
