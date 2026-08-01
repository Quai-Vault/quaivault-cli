import { Box, Text } from 'ink';
import {
  abiSourceBadge,
  abiSourceExplanation,
  formatAbsolute,
  formatApproximateAge,
  formatDuration,
  formatQuai,
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

function who(env: TuiEnv, address: string): string {
  const name = env.contactName(address);
  return name ? `${address}  (${safeText(name, 40)})` : address;
}

// ------------------------------------------------------------------- inbox

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
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <TxLine
          key={row.tx.hash}
          row={row}
          selected={state.scroll + i === state.selected}
          width={env.width}
        />
      ))}
    </Box>
  );
}

function TxLine({
  row,
  selected,
  width,
}: {
  row: TuiRow;
  selected: boolean;
  width: number;
}): React.ReactElement {
  const badge = abiSourceBadge(row.tx.abiSource);
  // Width-aware rather than the old hardcoded 44 columns.
  const summaryWidth = Math.max(12, width - 46);
  return (
    <Box>
      <Text color={selected ? 'cyan' : undefined}>{selected ? '❯ ' : '  '}</Text>
      <Box width={12}>
        <Text dimColor>{safeText(row.vaultLabel, 12)}</Text>
      </Box>
      <Box width={10}>
        <Text>{row.tx.hash.slice(2, 10)}</Text>
      </Box>
      <Box width={6}>
        <Text color={row.tx.approvalCount >= row.tx.threshold ? 'green' : undefined}>
          {row.tx.approvalCount}/{row.tx.threshold}
        </Text>
      </Box>
      <Box width={summaryWidth}>
        <Text wrap="truncate">{safeText(row.tx.summary, 200)}</Text>
      </Box>
      {row.tx.abiSource !== 'builtin' && <Text color={toneColor(badge.tone)}> {badge.text}</Text>}
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
    </Box>
  );
}

// ---------------------------------------------------------------- activity

export function ActivityPane({ state }: { state: TuiState }): React.ReactElement {
  if (!state.activity.length) {
    return <Text dimColor>No events yet. This fills as the chain moves.</Text>;
  }
  return (
    <Box flexDirection="column">
      {state.activity.slice(0, state.viewport).map((e, i) => (
        <Box key={`${e.at}-${i}`}>
          <Box width={10}>
            <Text dimColor>{formatAbsolute(e.at).slice(11, 19)}</Text>
          </Box>
          <Box width={16}>
            <Text color="cyan">{e.topic}</Text>
          </Box>
          <Box width={10}>
            <Text dimColor>{e.type}</Text>
          </Box>
          <Text dimColor>{e.vault.slice(0, 10)}…</Text>
        </Box>
      ))}
    </Box>
  );
}

// ----------------------------------------------------------------- history

export function HistoryPane({ state, env }: { state: TuiState; env: TuiEnv }): React.ReactElement {
  const rows = visibleRows(state);
  if (!rows.length) return <Text dimColor>No history for this vault.</Text>;
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Box key={row.tx.hash}>
          <Text color={state.scroll + i === state.selected ? 'cyan' : undefined}>
            {state.scroll + i === state.selected ? '❯ ' : '  '}
          </Text>
          <Box width={10}>
            <Text>{row.tx.hash.slice(2, 10)}</Text>
          </Box>
          <Box width={12}>
            <Text dimColor>{formatApproximateAge(row.tx.proposedAtBlock, row.chainHead) ?? ''}</Text>
          </Box>
          <Box width={11}>
            <Text color={row.tx.status === 'executed' ? 'green' : row.tx.status === 'failed' ? 'red' : 'yellow'}>
              {row.tx.status}
            </Text>
          </Box>
          <Box width={Math.max(12, env.width - 48)}>
            <Text wrap="truncate">{safeText(row.tx.summary, 200)}</Text>
          </Box>
        </Box>
      ))}
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
        <Box width={14}>
          <Text dimColor>kind</Text>
        </Box>
        {PROPOSE_KINDS.map((k) => (
          <Text key={k} color={k === form.kind ? 'cyan' : undefined} dimColor={k !== form.kind}>
            {k === form.kind ? '(•) ' : '( ) '}
            {k}
            {'  '}
          </Text>
        ))}
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
