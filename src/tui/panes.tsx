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
import { toneColor, type TuiEnv } from './env.js';
import {
  FORM_FIELDS,
  PROPOSE_KINDS,
  missingFields,
  visibleRows,
  type FormState,
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
      <Box width={14}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text color={tone}>{value}</Text>
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
  const w = Math.max(1, width);
  const text = safeText(value, w);
  return text.length > w ? text.slice(0, w) : text.padEnd(w);
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
        {state.load.status === 'degraded'
          ? 'Cannot see transactions — the indexer is unavailable. This is not "none".'
          : 'Nothing waiting on you.'}
      </Text>
    );
  }
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
  const r = state.recovery;
  if (!r) {
    return <Text color="green">No recovery pending on this vault.</Text>;
  }
  const left = r.executableAt ? r.executableAt - env.now() : 0;
  return (
    <Box flexDirection="column">
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
        value={left > 0 ? `in ${formatDuration(left)}` : 'now'}
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
  const vaultWidth = flexWidth(env.width, ACTIVITY_COLUMNS);
  return (
    <Box flexDirection="column">
      <TableHead columns={[...ACTIVITY_COLUMNS, { title: 'VAULT', width: vaultWidth }]} />
      {state.activity.slice(0, state.viewport).map((e, i) => (
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
  const rows = visibleRows(state);
  if (!rows.length) return <Text dimColor>No history for this vault.</Text>;
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
export function PolicyPane({ state }: { state: TuiState }): React.ReactElement {
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
  return (
    <Box flexDirection="column">
      <Text dimColor>
        Bounds non-interactive signing. You, at this terminal, are not restricted by it.
      </Text>
      <Box height={1} />
      {lines.map((line, i) => {
        const active = i === state.policyField;
        const editing = active && state.policyEdit !== null;
        return (
          <Box key={line.field}>
            <Box width={30}>
              <Text color={active ? 'cyan' : undefined} dimColor={!active}>
                {`${active ? '❯ ' : '  '}${line.field}`}
              </Text>
            </Box>
            {editing ? (
              <Box>
                <Text>{safeText(state.policyEdit ?? '', 120)}</Text>
                <Text color="cyan">▏</Text>
              </Box>
            ) : (
              <Text dimColor={line.value === ''}>
                {line.value === '' ? '(no limit)' : safeText(line.value, 120)}
              </Text>
            )}
          </Box>
        );
      })}
      <Box height={1} />
      {state.policyEdit !== null ? (
        <Text color="green">
          enter applies this through `qv policy set`, which validates it and rewrites the file
        </Text>
      ) : (
        <Text dimColor>
          e edits the selected field. Lists are comma-separated; empty means no limit.
        </Text>
      )}
    </Box>
  );
}

// ------------------------------------------------------------------- form

export function ProposePane({ state }: { state: TuiState }): React.ReactElement {
  const form = state.form;
  const fields = FORM_FIELDS[form.kind];
  const missing = missingFields(form);
  return (
    <Box flexDirection="column">
      <Box>
        <Box width={14} flexShrink={0}>
          <Text dimColor>kind</Text>
        </Box>
        {/* Wraps: the kind list outgrew one 80-column line once `delay` and
            `delegatecall` joined it, and a selector whose last options are off
            the edge is a selector with hidden options. */}
        <Box flexWrap="wrap">
          {PROPOSE_KINDS.map((k) => (
            <Text key={k} color={k === form.kind ? 'cyan' : undefined} dimColor={k !== form.kind}>
              {k === form.kind ? '(•) ' : '( ) '}
              {k}
              {'  '}
            </Text>
          ))}
        </Box>
      </Box>
      {form.field === -1 ? (
        <Text dimColor> ←/→ choose · tab to fill in the fields</Text>
      ) : null}
      <Box height={1} />
      {fields.map((f, i) => (
        <FormRow key={f.name} form={form} field={f} index={i} />
      ))}
      <Box height={1} />
      {missing.length ? (
        <Text dimColor>needs: {missing.join(', ')}</Text>
      ) : (
        <Text color="green">enter to build — a separate process re-reads the chain and shows you the transaction before anything is signed</Text>
      )}
      {form.error ? <Text color="red">{form.error}</Text> : null}
    </Box>
  );
}

function FormRow({
  form,
  field,
  index,
}: {
  form: FormState;
  field: (typeof FORM_FIELDS)[keyof typeof FORM_FIELDS][number];
  index: number;
}): React.ReactElement {
  const active = form.field === index;
  const value = form.values[field.name] ?? '';
  return (
    <Box>
      <Box width={14}>
        <Text dimColor={!active} color={active ? 'cyan' : undefined}>
          {active ? '❯ ' : '  '}
          {field.label}
        </Text>
      </Box>
      <Text>{value}</Text>
      {active ? <Text color="cyan">▏</Text> : null}
      {!value ? <Text dimColor>  {field.hint}</Text> : null}
    </Box>
  );
}
