import { Box, Text } from 'ink';
import {
  abiSourceBadge,
  abiSourceExplanation,
  formatAbsolute,
  formatApproximateAge,
  formatDuration,
  formatQuai,
  formatUnits,
  safeText,
  viewCalldata,
} from '../format/index.js';
import { fit, padCells, InputValue } from './text.js';
import { toneColor, type TuiEnv } from './env.js';
import {
  FORM_FIELDS,
  PROPOSE_KINDS,
  missingFields,
  visibleRows,
  selectedVault,
  type TuiRow,
  type TuiState,
} from './reducer.js';

/**
 * Pane projections (plan §4.4, §5.2).
 *
 * Every value shown here goes through `format/`. The TUI never calls
 * `render()` — the one-shot renderer composes lines, and Ink needs elements —
 * but both surfaces must agree byte-for-byte on the `abiSource` badge, amounts
 * and addresses, or the TUI renders provenance differently **on the surface
 * where a signature happens**. `test/unit/parity.test.ts` is what holds that.
 */

function Row({ label, value, tone }: { label: string; value: string; tone?: string }): React.ReactElement {
  return (
    <Box>
      <Box width={14} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexBasis={0}><Text color={tone}>{safeText(value, value.length + 1)}</Text></Box>
    </Box>
  );
}

// ------------------------------------------------------------------ tables

/**
 * Sanitize, then clamp to exactly `width`.
 *
 * `safeText` guarantees the string is printable and bounded; the pad makes it
 * *aligned*, which is what turns a list of fields into a table you can read
 * down a column of. Exact width is what lets a selected row be highlighted as
 * one continuous band rather than a row of ragged coloured words.
 */
function pad(value: string, width: number): string {
  return padCells(value, Math.max(1, width));
}

export interface Column {
  title: string;
  width: number;
}

/**
 * The column header.
 *
 * Present on every list pane, because the alternative is a grid of hashes and
 * bare integers where `2/3` could as easily be a date. The two leading spaces
 * align it past the selection marker.
 */
function TableHead({ columns }: { columns: readonly Column[] }): React.ReactElement {
  return (
    <Box>
      <Text bold dimColor>
        {`  ${columns.map((c) => pad(c.title, c.width)).join(' ')}`}
      </Text>
    </Box>
  );
}

/** Width of the selection marker, which every row and the header allow for. */
const MARKER = 2;

/**
 * Columns held back on the inbox for the provenance badge.
 *
 * Sized for the longest one — `guessed from selector`, 21 columns — plus its
 * leading space. This was 10 on the first cut, which is fine until a
 * heuristically-decoded transaction shows up and pushes the row twelve columns
 * past the edge, wrapping it. `test/unit/panes.test.tsx` asserts no badge
 * outgrows this.
 */
export const BADGE_RESERVE = 22;

/**
 * Remaining width for the final, flexible column.
 *
 * `reserve` is anything rendered *after* that column — the provenance badge on
 * the inbox. Getting this wrong is not cosmetic: a row one column too wide
 * wraps onto a second line, which desynchronizes the rendered rows from
 * `viewport` and pushes the last transaction out of a fixed-height layout.
 */
function flexWidth(
  total: number,
  columns: readonly Column[],
  reserve = 0,
  min = 12,
): number {
  const fixed = columns.reduce((sum, c) => sum + c.width + 1, 0);
  return Math.max(min, total - fixed - MARKER - reserve);
}

/**
 * Cells joined into one string, single-spaced.
 *
 * Built as a template literal rather than adjacent JSX expressions on purpose:
 * JSX strips whitespace before a newline, so `{pad(x, 12)} ` silently loses
 * its separator and every column after it slides left by one.
 */
function cells(parts: readonly (readonly [string, number])[]): string {
  return parts.map(([value, width]) => pad(value, width)).join(' ');
}

function who(env: TuiEnv, address: string): string {
  const name = env.contactName(address);
  return name ? `${address}  (${safeText(name, 40)})` : address;
}

// ------------------------------------------------------------------- inbox

const INBOX_COLUMNS: readonly Column[] = [
  { title: 'VAULT', width: 12 },
  { title: 'TX', width: 8 },
  { title: 'APPR', width: 5 },
];

export function InboxPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const rows = visibleRows(state);
  if (!rows.length) {
    return (
      <Text dimColor>
        {state.query ? 'No transactions match this search.' : state.load.status === 'loading' || state.load.status === 'idle' ? 'Loading transactions…' : state.load.status === 'error' ? 'Transactions unavailable. Press r to retry.' : state.load.status === 'degraded'
          ? 'Cannot see transactions — the indexer is unavailable. This is not "none".'
          : 'Nothing waiting on you.'}
      </Text>
    );
  }
  if (env.width < 80) return <Box flexDirection="column">
    <Text bold dimColor>{fit('  TX       VOTES ABI / SUMMARY', env.width)}</Text>
    {rows.map((row, i) => <Text key={`${row.vault}:${row.tx.hash}`} inverse={state.scroll + i === state.selected}>
      {fit(`${state.scroll + i === state.selected ? '❯' : ' '} ${row.tx.hash.slice(2, 10)} ${row.tx.approvalCount}/${row.tx.threshold} ${row.tx.abiSource === 'builtin' ? '' : `[${abiSourceBadge(row.tx.abiSource).text}] `}${row.tx.summary}`, env.width)}
    </Text>)}
  </Box>;
  const summaryWidth = flexWidth(env.width, INBOX_COLUMNS, BADGE_RESERVE);
  return (
    <Box flexDirection="column">
      <TableHead columns={[...INBOX_COLUMNS, { title: 'SUMMARY', width: summaryWidth }]} />
      {rows.map((row, i) => (
        <TxLine
          key={row.tx.hash}
          row={row}
          selected={state.scroll + i === state.selected}
          summaryWidth={summaryWidth}
        />
      ))}
    </Box>
  );
}

/**
 * One inbox row.
 *
 * Selection is reverse-video across the whole line rather than a coloured
 * marker. On a table the eye tracks the band, and the previous `❯` plus cyan
 * text was easy to lose among the other coloured cells — on the surface where
 * `a` approves whatever the cursor is on, "which row am I on" must not be a
 * question.
 */
function TxLine({
  row,
  selected,
  summaryWidth,
}: {
  row: TuiRow;
  selected: boolean;
  summaryWidth: number;
}): React.ReactElement {
  const badge = abiSourceBadge(row.tx.abiSource);
  const met = row.tx.approvalCount >= row.tx.threshold;
  const approvals = `${row.tx.approvalCount}/${row.tx.threshold}`;

  // The badge stays outside the highlight band and keeps its tone. It is a
  // provenance signal — "this calldata was not decoded from a known ABI" — and
  // dropping it to reverse-video on the selected row would mute the warning on
  // exactly the row the user is about to act on.
  const provenance =
    row.tx.abiSource !== 'builtin' ? (
      <Text color={toneColor(badge.tone)}>{` ${badge.text}`}</Text>
    ) : null;

  if (selected) {
    return (
      <Box>
        <Text inverse>
          {`❯ ${cells([
            [row.vaultLabel, 12],
            [row.tx.hash.slice(2, 10), 8],
            [approvals, 5],
            [row.tx.summary, summaryWidth],
          ])}`}
        </Text>
        {provenance}
      </Box>
    );
  }
  return (
    <Box>
      <Text dimColor>{`  ${pad(row.vaultLabel, 12)} `}</Text>
      <Text>{`${pad(row.tx.hash.slice(2, 10), 8)} `}</Text>
      <Text color={met ? 'green' : undefined}>{`${pad(approvals, 5)} `}</Text>
      <Text>{pad(row.tx.summary, summaryWidth)}</Text>
      {provenance}
    </Box>
  );
}

// ------------------------------------------------------------------ detail

export function DetailPane({
  row,
  env,
}: {
  row: TuiRow | undefined;
  env: TuiEnv;
}): React.ReactElement {
  if (!row) return <Text dimColor>Nothing selected.</Text>;
  const { tx } = row;
  const badge = abiSourceBadge(tx.abiSource);
  const note = abiSourceExplanation(tx.abiSource);
  const view = viewCalldata(tx.data);

  return (
    <Box flexDirection="column">
      <Text>{safeText(tx.summary, 200)}</Text>
      <Text dimColor>{tx.hash}</Text>
      <Row label="Vault" value={`${row.vault} (${row.vaultLabel})`} />
      <Box height={1} />
      <Row label="Decoded as" value={badge.text} tone={toneColor(badge.tone)} />
      {note ? <Row label="" value={note} tone="gray" /> : null}
      <Row label="To" value={who(env, tx.to)} />
      <Row label="Value" value={`${formatQuai(tx.value)} QUAI`} />
      {tx.value > 0n ? <Row label="" value={`exactly ${tx.value.toString(10)} wei`} /> : null}
      <Row label="Operation" value="call (the vault has no top-level delegatecall)" />

      {view.byteLength > 0 ? (
        <Box flexDirection="column">
          <Row
            label="Data"
            value={
              tx.abiSource === 'none'
                ? `unknown ABI — ${view.byteLength} bytes, showing raw calldata`
                : `${view.byteLength} bytes`
            }
            tone={tx.abiSource === 'none' ? 'yellow' : 'gray'}
          />
          {view.selector ? <Row label="" value={`selector  ${view.selector}`} /> : null}
          {view.words.map((w) => (
            <Row key={w.offset} label="" value={`[${String(w.offset).padStart(3, '0')}]  ${w.hex}`} />
          ))}
        </Box>
      ) : (
        <Row label="Data" value="(none)" />
      )}

      {row.batch ? <BatchBlock batch={row.batch} env={env} /> : null}

      <Box height={1} />
      <Row label="Approvals" value={`${tx.approvalCount} of ${tx.threshold}`} />
      {tx.approvals.map((a) => (
        <Row key={a.owner} label="" value={`${a.active ? '[x]' : '[ ]'} ${who(env, a.owner)}`} />
      ))}
      {tx.expiration > 0 ? (
        <Row
          label="Expires"
          value={`${
            tx.expiration - env.now() > 0
              ? `in ${formatDuration(tx.expiration - env.now())}`
              : 'expired'
          }   ${formatAbsolute(tx.expiration)}`}
          tone={tx.expiration - env.now() > 0 ? undefined : 'red'}
        />
      ) : null}
      {row.affordances.filter((a) => !a.allowed).map((a) => <Row key={a.action} label={a.action} value={a.reason ?? 'unavailable'} tone="gray" />)}
      {tx.executionDelay > 0 ? (
        <Row
          label="Timelock"
          value={`${formatDuration(tx.executionDelay)}${
            tx.executableAfter > 0
              ? `, executable after ${formatAbsolute(tx.executableAfter)}`
              : ', clock not started'
          }`}
        />
      ) : null}
    </Box>
  );
}

/** §7 "batch recurses" — the only place a delegatecall can be seen. */
function BatchBlock({
  batch,
  env,
}: {
  batch: NonNullable<TuiRow['batch']>;
  env: TuiEnv;
}): React.ReactElement {
  if (batch.error) {
    return (
      <Box flexDirection="column">
        <Box height={1} />
        <Text color="red">Batch        UNREADABLE — {safeText(batch.error, 200)}</Text>
        <Text color="red"> Treated as containing a delegatecall, because it might.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box height={1} />
      <Row label="Batch" value={`${batch.calls.length} sub-transactions`} />
      {batch.hasDelegatecall ? (
        <Text color="red"> contains a DELEGATECALL — that sub-call can rewrite vault storage</Text>
      ) : null}
      {batch.calls.map((call) => {
        const b = abiSourceBadge(call.abiSource);
        return (
          <Box key={call.index} flexDirection="column">
            <Box height={1} />
            <Text>
              [{call.index + 1}/{batch.calls.length}] {safeText(call.summary, 200)}
            </Text>
            <Text>
              {'  '}
              {call.isDelegatecall ? <Text color="red">DELEGATECALL</Text> : 'call'}{' '}
              <Text color={toneColor(b.tone)}>{b.text}</Text>
            </Text>
            <Text>
              {'  to     '}
              {who(env, call.to)}
            </Text>
            <Text>
              {'  value  '}
              {formatQuai(call.value)} QUAI
            </Text>
            {call.value > 0n ? <Text>{`  exactly ${call.value.toString(10)} wei`}</Text> : null}
            <Text>{`  data   ${call.data}`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ------------------------------------------------------------------- vault

export function VaultPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const d = state.vaultDetail;
  if (!d) return <Text dimColor>No vault selected, or still loading.</Text>;
  return (
    <Box flexDirection="column">
      <Row label="Receive" value={selectedVault(state)?.address ?? ''} />
      <Row label="Threshold" value={`${d.threshold} of ${d.owners.length} owners`} />
      <Row label="Balance" value={`${formatQuai(d.balanceWei)} QUAI`} />
      <Row
        label="Min timelock"
        value={d.minExecutionDelay > 0 ? formatDuration(d.minExecutionDelay) : 'none'}
      />
      <Box height={1} />
      <Text dimColor>Owners</Text>
      {d.owners.map((o) => (
        <Row key={o} label="" value={who(env, o)} />
      ))}
      <Box height={1} />
      <Text dimColor>Modules</Text>
      {d.modules.length ? (
        d.modules.map((m) => <Row key={m} label="" value={m} />)
      ) : (
        <Row label="" value="none enabled" />
      )}
      <Box height={1} />
      <Text dimColor>Delegatecall targets</Text>
      {(d.delegatecallTargets ?? []).length ? d.delegatecallTargets!.map((target) => <Row key={target} label="" value={target} />) : <Text dimColor>None indexed</Text>}
      <Box height={1} />
      <Text dimColor>Signed messages (EIP-1271)</Text>
      {(d.signedMessages ?? []).length ? d.signedMessages!.map((hash) => <Row key={hash} label="" value={hash} />) : <Text dimColor>None indexed</Text>}
    </Box>
  );
}

// ------------------------------------------------------------------ assets

export function AssetsPane({ state }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const detail = state.vaultDetail;
  if (!detail) return <Text dimColor>Asset data unavailable or still loading.</Text>;
  return (
    <Box flexDirection="column">
      <Row label="QUAI" value={`${formatQuai(detail.balanceWei)} QUAI`} />
      <Box height={1} />
      {(detail.tokens ?? []).length ? (
        (detail.tokens ?? []).map((token) => (
          <Row
            key={`${token.token}:${token.standard}`}
            label={safeText(token.symbol, 12)}
            value={`${formatUnits(token.balance, token.decimals)} ${token.standard}` +
              `${token.verified ? ' · verified' : ' · indexed'} · ${token.token}` +
              `${token.tokenIds?.length ? ` · ids ${token.tokenIds.join(', ')}` : ''}` +
              `${token.tokenIdsTruncated ? ' (partial id list)' : ''}`}
          />
        ))
      ) : (
        <Text dimColor>No indexed token holdings.</Text>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------- recovery

export function RecoveryPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const module = state.recoveryModule;
  const r = state.recovery;
  if (!module) {
    return <Text dimColor>Recovery module details are loading.</Text>;
  }
  if (!module.address) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No SocialRecoveryModule deployment is configured for this network.</Text>
        <Text dimColor>Check the active profile and network configuration.</Text>
      </Box>
    );
  }

  const left = r?.executableAt ? r.executableAt - env.now() : 0;
  return (
    <Box flexDirection="column">
      {state.recoveries.length > 1 || state.recoveryIndex < 0 ? <Text color="cyan">Request {state.recoveryIndex < 0 ? '—' : state.recoveryIndex + 1}/{state.recoveries.length} · ←/→ choose</Text> : null}
      {r ? <Row label="Request" value={r.hash} /> : null}
      <Row label="Module" value={module.address} />
      <Row
        label="Status"
        value={module.enabled ? 'enabled' : 'disabled'}
        tone={module.enabled ? 'green' : 'yellow'}
      />
      {!module.enabled ? (
        <Text color="cyan">Press s to propose enabling this configured recovery module.</Text>
      ) : null}
      {module.configured ? (
        <>
          <Row label="Guardians" value={`${module.threshold} of ${module.guardians.length}`} />
          <Row label="Period" value={formatDuration(module.recoveryPeriod)} />
          {module.guardians.map((guardian) => (
            <Row key={guardian} label="" value={who(env, guardian)} />
          ))}
          {module.enabled ? (
            <Text dimColor>
              Press s to update the guardian configuration · d to propose disabling recovery.
            </Text>
          ) : (
            <Text dimColor>This saved configuration is inactive while the module is disabled.</Text>
          )}
        </>
      ) : module.enabled ? (
        <Text color="cyan">No guardians configured. Press s to configure social recovery.</Text>
      ) : (
        <Text dimColor>No guardian configuration is set; configure it after enablement.</Text>
      )}
      <Box height={1} />
      {!r ? (
        <Text color={state.recoveries.length ? 'yellow' : 'green'}>{state.recoveries.length ? 'The selected request is no longer pending. Use ←/→ to choose another.' : 'No recovery pending on this vault.'}</Text>
      ) : (
        <>
          <Text color="red" bold>
            RECOVERY PENDING — this replaces the entire owner set.
          </Text>
          {(r.additional ?? 0) > 0 ? (
            <Text color="yellow">
              {r.additional ?? 0} additional pending recovery request(s); `qv recovery status` shows all.
            </Text>
          ) : null}
          <Box height={1} />
          <Row label="Approvals" value={`${r.approvals} of ${r.required} guardians`} />
          <Row
            label="Executable"
            value={!r.executableAt ? 'awaiting guardian threshold' : left > 0 ? `in ${formatDuration(left)}` : 'now'}
            tone={left > 0 ? 'yellow' : 'red'}
          />
          {r.expiration ? <Row label="Expires" value={formatAbsolute(r.expiration)} /> : null}
          <Box height={1} />
          <Text dimColor>Proposed new owners</Text>
          {r.newOwners.map((o) => (
            <Row key={o} label="" value={who(env, o)} />
          ))}
          <Row label="New threshold" value={String(r.newThreshold)} />
          <Box height={1} />
          <Text color="cyan">Press c to cancel this recovery. Cancelling is the defensive action.</Text>
          <Text dimColor>
            a approves it as a guardian · x executes it once the delay has elapsed. Each opens a
            separate process that shows you the new owner set before signing.
          </Text>
          {(r.affordances ?? [])
            .filter((item) => !item.allowed)
            .map((item) => (
              <Text key={item.action} dimColor>
                {item.action}: {safeText(item.reason, 160)}
              </Text>
            ))}
        </>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------- activity

const ACTIVITY_COLUMNS: readonly Column[] = [
  { title: 'TIME', width: 8 },
  { title: 'TOPIC', width: 16 },
  { title: 'TYPE', width: 10 },
];

export function ActivityPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  if (!state.activity.length) {
    return <Text dimColor>No events yet. This fills as the chain moves.</Text>;
  }
  if (env.width < 60) return <Box flexDirection="column"><Text bold dimColor>TIME     EVENT / VAULT</Text>{state.activity.map((e, i) => <Text key={i}>{fit(`${formatAbsolute(e.at).slice(11, 19)} ${e.topic} ${e.type} ${e.vault}`, env.width)}</Text>)}</Box>;
  const vaultWidth = flexWidth(env.width, ACTIVITY_COLUMNS);
  return (
    <Box flexDirection="column">
      <TableHead columns={[...ACTIVITY_COLUMNS, { title: 'VAULT', width: vaultWidth }]} />
      {state.activity.map((e, i) => (
        <Box key={`${e.at}-${i}`}>
          <Text dimColor>{`  ${pad(formatAbsolute(e.at).slice(11, 19), 8)} `}</Text>
          <Text color="cyan">{`${pad(e.topic, 16)} `}</Text>
          <Text dimColor>{`${pad(e.type, 10)} `}</Text>
          <Text dimColor>{pad(e.vault, vaultWidth)}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ----------------------------------------------------------------- history

const HISTORY_COLUMNS: readonly Column[] = [
  { title: 'TX', width: 8 },
  { title: 'AGE', width: 11 },
  { title: 'STATUS', width: 10 },
];

export function HistoryPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  if (state.historyKind !== 'transactions') {
    const page = state.historyRecords[state.historyKind];
    if (!page) return <Text dimColor>{state.scopedError ? 'History unavailable. Press r to retry.' : 'Loading history…'}</Text>;
    return <Box flexDirection="column">
      {!page.records.length ? <Text dimColor>No indexed {state.historyKind}.</Text> : null}
      {page.records.map((record, i) => <Box key={i} flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{safeText(record.title, 160)}</Text>
        {record.lines.map((line, j) => <Text key={j}>{safeText(line, 4096)}</Text>)}
      </Box>)}
      {page.hasMore ? <Text color="cyan">m load more {state.historyKind}</Text> : <Text dimColor>End of indexed {state.historyKind}.</Text>}
    </Box>;
  }
  const rows = visibleRows(state);
  if (!rows.length) return <Text dimColor>{state.query ? 'No history matches this search.' : state.scopedError ? 'History unavailable. Press r to retry.' : 'No loaded history for this vault.'}</Text>;
  if (env.width < 60) return <Box flexDirection="column"><Text bold dimColor>  TX       STATUS     SUMMARY</Text>{rows.map((row, i) => <Text key={row.tx.hash} inverse={state.scroll + i === state.selected}>{fit(`${state.scroll + i === state.selected ? '❯' : ' '} ${row.tx.hash.slice(2, 10)} ${row.tx.status} ${row.tx.summary}`, env.width)}</Text>)}</Box>;
  const summaryWidth = flexWidth(env.width, HISTORY_COLUMNS);
  return (
    <Box flexDirection="column">
      <TableHead columns={[...HISTORY_COLUMNS, { title: 'SUMMARY', width: summaryWidth }]} />
      {rows.map((row, i) => {
        const selected = state.scroll + i === state.selected;
        const age = formatApproximateAge(row.tx.proposedAtBlock, row.chainHead) ?? '';
        const line = cells([
          [row.tx.hash.slice(2, 10), 8],
          [age, 11],
          [row.tx.status, 10],
          [row.tx.summary, summaryWidth],
        ]);
        if (selected) {
          return (
            <Text key={row.tx.hash} inverse>{`❯ ${line}`}</Text>
          );
        }
        return (
          <Box key={row.tx.hash}>
            <Text>{`  ${pad(row.tx.hash.slice(2, 10), 8)} `}</Text>
            <Text dimColor>{`${pad(age, 11)} `}</Text>
            <Text
              color={
                row.tx.status === 'executed' ? 'green' : row.tx.status === 'failed' ? 'red' : 'yellow'
              }
            >
              {`${pad(row.tx.status, 10)} `}
            </Text>
            <Text>{pad(row.tx.summary, summaryWidth)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ------------------------------------------------------------------ policy

/**
 * The bound on non-interactive signing, and the one place it can be changed
 * without opening an editor.
 *
 * Read-only until `e`. Applying spawns `qv policy set`, so validation and the
 * write live in the one-shot command — the TUI never touches the file, and
 * this pane cannot become a second, laxer implementation of the bound.
 */
export function PolicyPane({ state, env }: { state: TuiState; env?: TuiEnv }): React.ReactElement {
  const lines = state.policy;
  if (!lines) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No policy file.</Text>
        <Box height={1} />
        <Text dimColor>
          Attended signing works without one. Non-interactive signing — agents, CI, any --yes
          invocation — does not.
        </Text>
        <Text dimColor>Create one with `qv policy init`, then come back.</Text>
      </Box>
    );
  }
  const count = Math.max(1, state.viewport - 4);
  const start = Math.max(0, Math.min(state.policyField - count + 1, lines.length - count));
  return (
    <Box flexDirection="column">
      <Text dimColor>{fit(`Policy · ${lines[state.policyField]?.field ?? ''}`, env?.width ?? 100)}</Text>
      <Box height={1} />
      {lines.slice(start, start + count).map((line, i) => {
        const active = start + i === state.policyField;
        const editing = active && state.policyEdit !== null;
        return (
          <Box key={line.field} height={1} flexShrink={0}>
            <Box width={Math.min(30, Math.floor((env?.width ?? 100) / 2))} flexShrink={0}>
              <Text color={active ? 'cyan' : undefined} dimColor={!active}>
                {fit(`${active ? '❯ ' : '  '}${line.field}`, Math.min(30, Math.floor((env?.width ?? 100) / 2)))}
              </Text>
            </Box>
            {editing ? (
              <InputValue value={state.policyEdit ?? ''} cursor={state.policyCursor} width={(env?.width ?? 100) - Math.min(30, Math.floor((env?.width ?? 100) / 2))} />
            ) : (
              <Text dimColor={line.value === ''}>
                {line.value === '' ? '(no limit)' : fit(line.value, (env?.width ?? 100) - Math.min(30, Math.floor((env?.width ?? 100) / 2)))}
              </Text>
            )}
          </Box>
        );
      })}
      <Box height={1} />
      {state.policyError ? <Text color="red">{state.policyError}</Text> : null}
      {state.policyEdit !== null ? (
        <Text color="green">{fit('Enter validates and applies · Esc cancels', env?.width ?? 100)}</Text>
      ) : (
        <Text dimColor>{fit('e edit · lists use commas · empty = no limit', env?.width ?? 100)}</Text>
      )}
    </Box>
  );
}

// ------------------------------------------------------------------- form

export function ProposePane({ state, env }: { state: TuiState; env?: TuiEnv }): React.ReactElement {
  const form = state.form;
  const fields = FORM_FIELDS[form.kind];
  const missing = missingFields(form);
  const width = env?.width ?? 100;
  const roomy = state.viewport >= 8;
  const count = Math.max(1, state.viewport - (roomy ? 4 : 3));
  const start = Math.max(0, Math.min(form.field - count + 1, fields.length - count));
  return <Box flexDirection="column">
    <Text><Text dimColor>kind  </Text><Text bold inverse={form.field === -1} color="cyan">{form.kind}</Text><Text dimColor>  {PROPOSE_KINDS.indexOf(form.kind) + 1}/{PROPOSE_KINDS.length}  ←/→</Text></Text>
    {roomy ? <Text dimColor>{form.field < 0 ? 'Enter to fill fields · Tab next pane' : `Field ${form.field + 1}/${fields.length} · Shift-Tab back to kind`}</Text> : null}
    {fields.slice(start, start + count).map((field, i) => {
      const active = form.field === start + i;
      const value = form.values[field.name] ?? '';
      return <Box key={field.name} height={1} flexShrink={0}>
        <Box width={14} flexShrink={0}><Text dimColor={!active} color={active ? 'cyan' : undefined}>{fit(`${active ? '❯' : ' '} ${field.label}${field.required ? '*' : ''}`, 14)}</Text></Box>
        {active ? <InputValue value={value} cursor={form.cursor} width={width - 14} /> : <Text dimColor={!value}>{fit(value || field.hint, width - 14)}</Text>}
      </Box>;
    })}
    <Text dimColor>{fit(form.field >= 0 ? fields[form.field]!.hint : '* required', width)}</Text>
    <Text color={form.error ? 'red' : missing.length ? undefined : 'green'} dimColor={!form.error && missing.length > 0}>
      {fit(form.error ?? (missing.length ? `Needs: ${missing.join(', ')}` : 'Enter on last field to review before signing'), width)}
    </Text>
  </Box>;
}
