# Contributing

```bash
npm ci --ignore-scripts
npm run check      # typecheck + lint + test — the same gate CI runs
npm run build
```

Node 22 or later.

## Adding a command

A command is a `CommandSpec` descriptor plus one line in `src/cli/registry.ts`. It must
not reach for stdout, `connect()`, or the keystore directly:

- `run()` returns data and never prints. Writes implement `plan()` + `commit()` instead,
  so confirmation sits between them and `--dry-run` is free.
- `render()` prints human text; `toJson()` returns the CLI-owned JSON shape. Both are
  required, and so is `outputSchema` — a test fails the build without it, because
  `qv --schema` is a traversal of the registry and would otherwise drift silently.
- Formatting lives in `src/format/`, which returns `{text, tone}` values rather than
  escape sequences, so the TUI and the one-shot renderer cannot diverge.

## Rules that are not style preferences

- **Every `switch` on an SDK union ends with a `never` exhaustiveness assert.** The SDK
  is pre-1.0 and has already widened one union in a patch cycle; without the assert a new
  member fails *open* on the pre-approval screen.
- **Bigints serialize as decimal strings.** `JSON.stringify` throws on a raw bigint and
  `Number()` silently loses precision above 0.009 QUAI.
- **Never add a flag that carries a secret.** A registry test enforces this.
- **Never `util.inspect` or `JSON.stringify` a raw error.** A `quais` provider error
  carries the full JSON-RPC request body on `.info.payload`.

## Tests

Unit tests use a hand-written fake client typed against the real SDK — **not `vi.mock`**.
A module mock does not typecheck against the SDK, so a changed return shape would leave
tests green while the CLI is broken. The fake fails `npm run typecheck` on the same
change, which is the point.

Network access from a unit test throws (see `test/setup.ts`), including WebSocket.
