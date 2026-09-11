import type { Affordance, RecoveryAffordance, TokenBalance, VaultTransaction } from '@quaivault/sdk';
import { editText, EDIT_KEYS } from './editor.js';
import type { BatchAnalysis } from '../abi/batch.js';

/**
 * The TUI is a pure state machine; Ink is a thin projection of it.
 *
 * Everything worth testing lives here — pane routing, navigation, selection,
 * scrolling, degraded state, form entry, and the fact that **the TUI never
 * holds key material**. All of it is testable with no terminal, which is why
 * the reducer is the seam rather than snapshotting frames (plan §6, Tier 6).
 *
 * Nothing in this file may import an SDK *value* — only types. The lint
 * boundary in eslint.config.js enforces it, because §4.4's rule that the TUI
 * can do nothing the one-shot surface cannot is worth nothing as a convention.
 */

// ------------------------------------------------------------------- panes

export type Pane =
  | 'inbox'
  | 'history'
  | 'activity'
  | 'assets'
  | 'vault'
  | 'recovery'
  | 'policy'
  | 'propose';

/** Tab order. Monitoring panes first, the ones that write last. */
export const PANES: readonly Pane[] = [
  'inbox',
  'history',
  'activity',
  'assets',
  'vault',
  'recovery',
  'policy',
  'propose',
];

/**
 * One line of the policy, as text.
 *
 * The reducer is handed rendered strings rather than a `Policy`: parsing and
 * validation belong to `qv policy set`, which is what actually writes the
 * file. The TUI shows what is there and produces argv, exactly as the propose
 * form does — it must not become a second implementation of the bound.
 */
export interface PolicyLine {
  field: string;
  value: string;
}

export interface TuiRow {
  vault: string;
  vaultLabel: string;
  tx: VaultTransaction;
  affordances: Affordance[];
  /**
   * Batch analysis, computed outside `tui/` and handed in as data.
   *
   * `analyzeBatch` imports SDK values, which the lint boundary forbids here —
   * and rightly: the components should be projecting data, not decoding
   * calldata. The type import is erased at build time.
   */
  batch: BatchAnalysis | null;
  /** Chain head at read time; approximate age is meaningless without it. */
  chainHead?: number;
}

export interface VaultSummary {
  address: string;
  label: string;
  pending: number;
  hasRecovery: boolean;
}

export interface VaultDetail {
  delegatecallTargets?: string[];
  signedMessages?: string[];
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  modules: string[];
  balanceWei: bigint;
  tokens?: TokenBalance[];
}

export interface RecoveryDetail {
  hash: string;
  newOwners: string[];
  newThreshold: number;
  approvals: number;
  required: number;
  executableAt?: number;
  expiration?: number;
  affordances?: RecoveryAffordance[];
  additional?: number;
}

/** Configuration and enablement are independent of a pending recovery. */
export interface RecoveryModuleDetail {
  /** Null when this network/profile has no SocialRecoveryModule deployment configured. */
  address: string | null;
  enabled: boolean;
  configured: boolean;
  guardians: string[];
  threshold: number;
  recoveryPeriod: number;
}

/** One line of the change feed. Topic and type only — never a raw row (§8 R10). */
export interface ActivityEntry {
  at: number;
  topic: string;
  type: string;
  vault: string;
}

export interface LoadState {
  status: 'idle' | 'loading' | 'ok' | 'error' | 'degraded';
  error?: string;
  fetchedAt?: number;
}

// -------------------------------------------------------------------- form

export type ProposeKind =
  | 'transfer'
  | 'token'
  | 'nft'
  | 'erc1155'
  | 'call'
  | 'batch'
  | 'abi-call'
  | 'add-owner'
  | 'remove-owner'
  | 'threshold'
  | 'delay'
  | 'module'
  | 'delegatecall'
  | 'cancel-by-consensus'
  | 'sign-message'
  | 'setup-recovery'
  | 'initiate-recovery'
  | 'create-vault';

/**
 * The literal a user types to arm `--i-understand-unverified`.
 *
 * Whitelisting a DelegateCall target is the strongest authority the vault can
 * grant — that target can rewrite vault storage — so the one-shot command
 * refuses without the flag. The form does not pass it silently: typing this is
 * the same deliberate act, in the same spirit as the typed address `qv key rm`
 * asks for.
 */
export const UNVERIFIED_ACK = 'i-understand';

export interface FormField {
  name: string;
  label: string;
  hint: string;
  required: boolean;
}

/**
 * The fields each proposal kind needs, and nothing more.
 *
 * These map one-to-one onto the flags of the corresponding `qv propose`
 * command, because that is all the form ever produces — see `formArgv`.
 */
export const FORM_FIELDS: Record<ProposeKind, readonly FormField[]> = {
  transfer: [
    { name: 'to', label: 'to', hint: '0x… recipient', required: true },
    { name: 'amount', label: 'amount', hint: 'in QUAI, e.g. 1.5', required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank for never', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  token: [
    { name: 'token', label: 'token', hint: '0x… token contract', required: true },
    { name: 'to', label: 'to', hint: '0x… recipient', required: true },
    { name: 'amount', label: 'amount', hint: 'in token units', required: true },
    { name: 'decimals', label: 'decimals', hint: 'token decimals, e.g. 6 or 18', required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  nft: [
    { name: 'token', label: 'collection', hint: '0x… ERC-721 contract', required: true },
    { name: 'to', label: 'to', hint: '0x… recipient', required: true },
    { name: 'tokenId', label: 'token id', hint: 'integer token id', required: true },
  ],
  erc1155: [
    { name: 'token', label: 'token', hint: '0x… ERC-1155 contract', required: true },
    { name: 'to', label: 'to', hint: '0x… recipient', required: true },
    { name: 'tokenId', label: 'token id', hint: 'integer token id', required: true },
    { name: 'amount', label: 'amount', hint: 'raw quantity', required: true },
    { name: 'data', label: 'receiver data', hint: 'optional hex receiver data, default 0x', required: false },
  ],
  call: [
    { name: 'to', label: 'contract', hint: '0x… target contract', required: true },
    { name: 'data', label: 'calldata', hint: '0x… encoded calldata', required: true },
    { name: 'value', label: 'value', hint: 'QUAI, blank for zero', required: false },
  ],
  'abi-call': [
    { name: 'to', label: 'to', hint: 'target contract address', required: true },
    { name: 'abi', label: 'ABI file', hint: 'path to a local JSON ABI file', required: true },
    { name: 'function', label: 'function', hint: 'function name or full signature', required: true },
    { name: 'argsJson', label: 'arguments', hint: 'JSON array, default []', required: false },
    { name: 'value', label: 'value', hint: 'QUAI to send, default 0', required: false },
  ],
  batch: [
    { name: 'request', label: 'request file', hint: 'path to batch JSON', required: true },
  ],
  'add-owner': [
    { name: 'owner', label: 'owner', hint: '0x… new owner', required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  'remove-owner': [
    { name: 'owner', label: 'owner', hint: '0x… owner to remove', required: true },
  ],
  threshold: [
    { name: 'threshold', label: 'threshold', hint: 'new signature count', required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  delay: [
    { name: 'minDelay', label: 'min timelock', hint: "the vault's new floor, e.g. 24h or 0", required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  module: [
    { name: 'action', label: 'action', hint: 'enable or disable', required: true },
    { name: 'module', label: 'module', hint: '0x… module address', required: true },
    { name: 'acknowledge', label: 'acknowledge', hint: `to enable, type ${UNVERIFIED_ACK}`, required: false },
  ],
  delegatecall: [
    { name: 'action', label: 'action', hint: 'add or rm', required: true },
    { name: 'target', label: 'target', hint: '0x… delegatecall target', required: true },
    {
      name: 'acknowledge',
      label: 'acknowledge',
      hint: `to add, type ${UNVERIFIED_ACK} — the target can rewrite vault storage`,
      required: false,
    },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  'cancel-by-consensus': [
    { name: 'hash', label: 'transaction', hint: 'full transaction hash', required: true },
  ],
  'sign-message': [
    { name: 'message', label: 'message', hint: '0x… bytes', required: true },
    { name: 'action', label: 'action', hint: 'sign or unsign', required: true },
  ],
  'setup-recovery': [
    { name: 'guardians', label: 'guardians', hint: 'comma-separated addresses', required: true },
    { name: 'threshold', label: 'threshold', hint: 'guardian approvals required', required: true },
    { name: 'recoveryPeriod', label: 'period', hint: 'e.g. 7d', required: true },
  ],
  'initiate-recovery': [
    { name: 'owners', label: 'new owners', hint: 'comma-separated addresses', required: true },
    { name: 'threshold', label: 'threshold', hint: 'new owner threshold', required: true },
  ],
  'create-vault': [
    { name: 'owners', label: 'owners', hint: 'comma-separated addresses', required: true },
    { name: 'threshold', label: 'threshold', hint: 'approvals required', required: true },
    { name: 'minDelay', label: 'timelock', hint: 'e.g. 24h or 0', required: false },
  ],
};

for (const [kind, fields] of Object.entries(FORM_FIELDS)) {
  if (kind === 'create-vault' || kind === 'initiate-recovery') continue;
  for (const field of [
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank for never', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
    { name: 'idempotencyKey', label: 'retry key', hint: 'optional unique key to prevent duplicate proposals', required: false },
  ]) if (!fields.some((f) => f.name === field.name)) FORM_FIELDS[kind as ProposeKind] = [...FORM_FIELDS[kind as ProposeKind], field];
}

export const PROPOSE_KINDS = Object.keys(FORM_FIELDS) as ProposeKind[];

export interface FormState {
  kind: ProposeKind;
  /** Index into FORM_FIELDS[kind]; `-1` means the kind selector is focused. */
  field: number;
  values: Record<string, string>;
  error?: string;
  cursor?: number;
}

export function initialForm(kind: ProposeKind = 'transfer'): FormState {
  return { kind, field: -1, values: {} };
}

// ------------------------------------------------------------------- state

export const HISTORY_KINDS = ['transactions', 'deposits', 'transfers', 'recoveries'] as const;
export type HistoryKind = typeof HISTORY_KINDS[number];
export interface HistoryRecord { title: string; lines: string[] }
export interface HistoryRecords { records: HistoryRecord[]; hasMore: boolean }

export interface TuiState {
  pane: Pane;
  /** Detail overlay for the selected transaction. Only inbox and history. */
  detail: boolean;
  vaults: VaultSummary[];
  selectedVault: number;
  rows: TuiRow[];
  history: TuiRow[];
  activity: ActivityEntry[];
  vaultDetail: VaultDetail | null;
  recoveryModule: RecoveryModuleDetail | null;
  recovery: RecoveryDetail | null;
  /** Null means no policy file exists, which is not the same as an empty one. */
  policy: PolicyLine[] | null;
  policyField: number;
  /** The edit buffer. Null means not editing — the pane is read-only then. */
  policyEdit: string | null;
  selected: number;
  scroll: number;
  viewport: number;
  load: LoadState;
  /** Always false. The TUI delegates signing to a spawned one-shot process. */
  holdsKey: false;
  /** Set while a spawned child owns the terminal. */
  signing: { hash: string; action: string } | null;
  lastSignResult: { ok: boolean; message: string } | null;
  form: FormState;
  quit: boolean;
  help: boolean;
  query: string;
  searching: boolean;
  bodyScroll: number;
  bodyRows: number;
  policyCursor?: number;
  policyError?: string;
  scopedError?: string;
  historyHasMore: boolean;
  historyKind: HistoryKind;
  historyRecords: Partial<Record<HistoryKind, HistoryRecords>>;
  recoveries: RecoveryDetail[];
  recoveryIndex: number;
}

export type TuiEvent =
  | { type: 'key'; key: string }
  | { type: 'paste'; text: string }
  | { type: 'resize'; rows: number }
  | { type: 'data'; rows: TuiRow[]; degraded: boolean; at: number; warning?: string }
  | { type: 'vaults'; vaults: VaultSummary[] }
  | { type: 'history'; rows: TuiRow[]; address?: string; hasMore?: boolean }
  | { type: 'vault-detail'; address?: string; detail: VaultDetail | null }
  | { type: 'recovery-module'; address?: string; detail: RecoveryModuleDetail | null }
  | { type: 'recovery'; address?: string; detail: RecoveryDetail | null }
  | { type: 'history-records'; address: string; kind: HistoryKind; page: HistoryRecords }
  | { type: 'body-size'; rows: number }
  | { type: 'scoped-error'; address: string; message?: string }
  | { type: 'recoveries'; address: string; details: RecoveryDetail[] }
  | { type: 'open-form'; kind: ProposeKind }
  | { type: 'policy'; lines: PolicyLine[] | null }
  | { type: 'policy-edit'; value: string | null }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'sign-start'; hash: string; action: string }
  | { type: 'sign-end'; ok: boolean; message: string };

/** Bounded so a busy vault cannot grow the activity log without limit. */
export const ACTIVITY_LIMIT = 200;

/** Bounded inputs, with room for calldata, file paths and address lists. */
export const MAX_FIELD_LENGTH = 128;
export const MAX_POLICY_LENGTH = 8192;
export function fieldLimit(name: string): number {
  if (name === 'data') return 65538;
  if (name === 'request' || name === 'abi') return 4096;
  if (name === 'argsJson') return 32768;
  if (name === 'owners' || name === 'guardians') return 8192;
  return MAX_FIELD_LENGTH;
}

/**
 * Control and format characters, stripped from anything pasted.
 *
 * `Cc` catches the newline a copied address usually carries — and `return` on
 * the last field is the submit gesture, so a paste that kept its newline could
 * submit a form the user was still filling in. `Cf` catches zero-width and
 * bidirectional-override characters, which is the difference between an
 * address you can read and one that renders as something other than what it
 * is.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

export function initialState(viewport = 10): TuiState {
  return {
    pane: 'inbox',
    detail: false,
    vaults: [],
    selectedVault: 0,
    rows: [],
    history: [],
    activity: [],
    vaultDetail: null,
    recoveryModule: null,
    recovery: null,
    policy: null,
    policyField: 0,
    policyEdit: null,
    selected: 0,
    scroll: 0,
    viewport,
    load: { status: 'idle' },
    holdsKey: false,
    signing: null,
    lastSignResult: null,
    form: initialForm(),
    quit: false, help: false, query: '', searching: false, bodyScroll: 0, bodyRows: 0,
    historyHasMore: false, historyKind: 'transactions', historyRecords: {}, recoveries: [], recoveryIndex: 0,
  };
}

/** The list the current pane is navigating, if it navigates one at all. */
export function activeList(state: TuiState): TuiRow[] {
  const rows = state.pane === 'history' && state.historyKind === 'transactions' ? state.history : state.pane === 'inbox' ? state.rows : [];
  return filterRows(rows, state.query);
}

function filterRows(rows: TuiRow[], query: string): TuiRow[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((r) => [r.vaultLabel, r.vault, r.tx.hash, r.tx.to, r.tx.summary, r.tx.status].some((v) => v.toLowerCase().includes(q))) : rows;
}

/**
 * Keep the cursor on the *transaction* it was on, not the index.
 *
 * A refresh can reorder or shorten the list — an approval lands, something
 * executes, a vault's reads come back in a different order. Following the
 * index means the row under the cursor silently becomes a different
 * transaction, and this is a surface people approve from. Following the hash
 * means the worst case is the selection falling back to a clamped index
 * because the transaction genuinely went away.
 */
function reselect(
  state: TuiState,
  pane: Pane,
  before: readonly TuiRow[],
  after: readonly TuiRow[],
): number {
  if (state.pane !== pane) return state.selected;
  const anchor = filterRows([...before], state.query)[state.selected];
  const moved = anchor ? filterRows([...after], state.query).findIndex((r) => sameRow(r, anchor)) : -1;
  return moved >= 0 ? moved : Math.min(state.selected, Math.max(0, filterRows([...after], state.query).length - 1));
}

function clampScroll(state: TuiState): TuiState {
  const { selected, scroll, viewport } = state;
  const length = activeList(state).length;
  let next = scroll;
  if (selected < scroll) next = selected;
  else if (selected >= scroll + viewport) next = selected - viewport + 1;
  next = Math.max(0, Math.min(next, Math.max(0, length - viewport)));
  return next === scroll ? state : { ...state, scroll: next };
}

function sameRow(a: TuiRow, b: TuiRow): boolean {
  return a.tx.hash === b.tx.hash && a.vault.toLowerCase() === b.vault.toLowerCase();
}

export function reduce(state: TuiState, event: TuiEvent): TuiState {
  if ('address' in event && event.address &&
      event.address.toLowerCase() !== selectedVault(state)?.address.toLowerCase()) return state;
  switch (event.type) {
    case 'history-records': return { ...state, historyRecords: { ...state.historyRecords, [event.kind]: event.page } };
    case 'body-size': {
      const bodyScroll = Math.min(state.bodyScroll, Math.max(0, event.rows - state.viewport));
      return state.bodyRows === event.rows && state.bodyScroll === bodyScroll ? state :
        { ...state, bodyRows: event.rows, bodyScroll };
    }
    case 'scoped-error': return { ...state, scopedError: event.message };
    case 'recoveries': {
      const index = state.recovery ? event.details.findIndex((r) => r.hash === state.recovery?.hash) :
        state.recoveryIndex < 0 ? -1 : 0;
      return { ...state, recoveries: event.details, recoveryIndex: index, recovery: event.details[index] ?? null };
    }
    case 'loading':
      return { ...state, load: { ...state.load, status: 'loading' } };

    case 'data': {
      const selected = reselect(state, 'inbox', state.rows, event.rows);
      return clampScroll({
        ...state,
        rows: event.rows,
        selected,
        detail: state.detail && (state.pane !== 'inbox' || event.rows.some((r) => selectedRow(state) && sameRow(r, selectedRow(state)!))),
        // "no results" and "cannot see results" are different things, and the
        // difference must survive a refresh.
        load: { status: event.degraded ? 'degraded' : 'ok', fetchedAt: event.at, error: event.warning },
      });
    }

    case 'vaults': {
      // Follow the *vault*, not the index — the same reason `reselect` follows
      // a transaction hash. `loadVaults` returns owned-then-guardian in
      // indexer order, so a vault appearing or disappearing shifts every index
      // after it. Anchoring on the index means the cursor silently lands on a
      // different vault, and the propose form builds against whatever it
      // landed on.
      const anchor = state.vaults[state.selectedVault]?.address.toLowerCase();
      const moved = anchor
        ? event.vaults.findIndex((v) => v.address.toLowerCase() === anchor)
        : -1;
      return {
        ...state,
        ...(anchor && moved < 0 ? { vaultDetail: null, recoveryModule: null, recovery: null,
          recoveries: [], recoveryIndex: 0, history: [], historyHasMore: false, historyRecords: {}, detail: false } : {}),
        vaults: event.vaults,
        selectedVault:
          moved >= 0 ? moved : Math.min(state.selectedVault, Math.max(0, event.vaults.length - 1)),
      };
    }

    case 'history':
      return clampScroll({
        ...state,
        history: event.rows,
        historyHasMore: event.hasMore ?? false,
        detail: state.detail && (state.pane !== 'history' || event.rows.some((r) => selectedRow(state) && sameRow(r, selectedRow(state)!))),
        selected: reselect(state, 'history', state.history, event.rows),
      });

    case 'vault-detail':
      return { ...state, vaultDetail: event.detail };

    case 'recovery-module':
      return { ...state, recoveryModule: event.detail };

    case 'recovery':
      return { ...state, recovery: event.detail };

    case 'open-form':
      return {
        ...state,
        pane: 'propose',
        detail: false,
        selected: 0,
        scroll: 0,
        form: { ...initialForm(event.kind), field: 0, cursor: undefined },
      };

    case 'policy':
      return {
        ...state,
        policy: event.lines,
        policyField: Math.min(state.policyField, Math.max(0, (event.lines?.length ?? 1) - 1)),
      };

    case 'policy-edit':
      return { ...state, policyEdit: event.value, policyCursor: undefined, policyError: undefined };

    case 'activity':
      return { ...state, activity: [event.entry, ...state.activity].slice(0, ACTIVITY_LIMIT) };

    case 'error':
      return { ...state, load: { status: 'error', error: event.message } };

    case 'resize':
      return clampScroll({ ...state, viewport: Math.max(1, event.rows) });

    case 'sign-start':
      // Signing happens in a spawned one-shot process. The TUI records that it
      // is happening; it never gains key material by doing so.
      return { ...state, signing: { hash: event.hash, action: event.action } };

    case 'sign-end':
      return {
        ...state,
        signing: null,
        lastSignResult: { ok: event.ok, message: event.message },
      };

    case 'key':
      return reduceKey(state, event.key);

    case 'paste':
      return reducePaste(state, event.text);

    default: {
      const never: never = event;
      throw new Error(`unhandled tui event: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * The only keys the kind selector claims. Everything else — tab, q, r, j/k —
 * keeps its normal meaning, so the pane is never a place you cannot leave.
 */
const KIND_SELECTOR_KEYS = new Set(['left', 'right', 'h', 'l', 'return', 'down', 'escape']);

function cyclePane(state: TuiState, direction: 1 | -1): TuiState {
  const at = PANES.indexOf(state.pane);
  const next = PANES[(at + direction + PANES.length) % PANES.length] as Pane;
  return clampScroll({ ...state, pane: next, detail: false, selected: 0, scroll: 0, bodyScroll: 0, query: '', searching: false });
}

/**
 * Move the vault cursor.
 *
 * The vault-scoped panes — history, vault, recovery — and the propose form all
 * read `selectedVault`, so this is the one gesture that changes what four of
 * the six panes are about. Their contents are **cleared rather than kept**:
 * a reload is in flight, and the previous vault's owner set or history sitting
 * under the new vault's label is a misread waiting to happen on a surface
 * people approve from. Empty and briefly loading is honest; stale and
 * mislabelled is not.
 *
 * `rows` deliberately survives — the inbox is cross-vault and does not change
 * meaning when the vault cursor moves.
 */
function selectVault(state: TuiState, direction: 1 | -1): TuiState {
  if (state.vaults.length < 2) return state;
  const next = (state.selectedVault + direction + state.vaults.length) % state.vaults.length;
  return clampScroll({
    ...state,
    selectedVault: next,
    bodyScroll: 0, scopedError: undefined, historyHasMore: false, historyRecords: {}, recoveries: [], recoveryIndex: 0,
    detail: false,
    selected: state.pane === 'inbox' ? state.selected : 0,
    scroll: state.pane === 'inbox' ? state.scroll : 0,
    history: [],
    vaultDetail: null,
    recoveryModule: null,
    recovery: null,
  });
}

function reduceKey(state: TuiState, key: string): TuiState {
  // While a spawned signer owns the terminal, the TUI ignores input entirely.
  if (state.signing) return state;
  if (state.help) {
    if (['?', 'escape', 'q'].includes(key)) return { ...state, help: false, bodyScroll: 0 };
    return scrollBody(state, key);
  }
  if (state.searching) {
    if (key === 'return') return { ...state, searching: false };
    if (key === 'escape') return { ...state, searching: false, query: '', selected: 0, scroll: 0 };
    const query = key === 'backspace' ? Array.from(state.query).slice(0, -1).join('') :
      key === 'ctrl-u' ? '' : Array.from(key).length === 1 && !/[\p{Cc}\p{Cf}]/u.test(key) ? (state.query + key).slice(0, 128) : state.query;
    return { ...state, query, selected: 0, scroll: 0 };
  }

  // The propose pane is a text form, so printable characters are content
  // rather than commands — but **only once a field is focused**. On the kind
  // selector nothing is being typed, so only the gestures that mean something
  // there are claimed; everything else falls through to normal pane handling.
  //
  // Getting this wrong makes `propose` a trap. It is last in the tab order,
  // so if the form swallowed `tab` you could never cycle out of it, and if it
  // swallowed `q` you could not quit from it either — both of which it did
  // until someone actually ran the thing.
  if (state.pane === 'propose' && !state.detail) {
    if (state.form.field >= 0) return reduceForm(state, key);
    if (KIND_SELECTOR_KEYS.has(key)) return reduceForm(state, key);
  }

  if (state.pane === 'policy' && !state.detail) {
    const handled = reducePolicy(state, key);
    if (handled) return handled;
  }

  if (key === '?') return { ...state, help: true, bodyScroll: 0 };
  if (/^[1-8]$/.test(key)) return { ...state, pane: PANES[Number(key) - 1]!, detail: false, selected: 0, scroll: 0, bodyScroll: 0, query: '' };
  if (key === '/' && !state.detail && (state.pane === 'inbox' || (state.pane === 'history' && state.historyKind === 'transactions'))) return { ...state, searching: true };
  if (state.pane === 'history' && !state.detail && ['left', 'right'].includes(key)) {
    const index = (HISTORY_KINDS.indexOf(state.historyKind) + (key === 'right' ? 1 : -1) + HISTORY_KINDS.length) % HISTORY_KINDS.length;
    return { ...state, historyKind: HISTORY_KINDS[index]!, query: '', searching: false, selected: 0, scroll: 0, bodyScroll: 0 };
  }
  if (state.pane === 'recovery' && !state.detail && ['left', 'right'].includes(key) && state.recoveries.length) {
    const recoveryIndex = (state.recoveryIndex + (key === 'right' ? 1 : -1) + state.recoveries.length) % state.recoveries.length;
    return { ...state, recoveryIndex, recovery: state.recoveries[recoveryIndex]!, bodyScroll: 0 };
  }
  if (state.detail || (state.pane === 'history' && state.historyKind !== 'transactions') || !['inbox', 'history', 'propose', 'policy'].includes(state.pane)) {
    const scrolled = scrollBody(state, key);
    if (scrolled !== state) return scrolled;
    if (['j', 'k', 'up', 'down', 'g', 'G', 'home', 'end', 'page-up', 'page-down'].includes(key)) return state;
  }
  switch (key) {
    case 'tab':
      return cyclePane(state, 1);
    case 'shift-tab':
      return cyclePane(state, -1);
    case 'q':
      return state.detail ? { ...state, detail: false } : { ...state, quit: true };
    case 'escape':
      return state.detail ? { ...state, detail: false } : state;
    case 'j':
    case 'down':
      return clampScroll({
        ...state,
        selected: Math.min(state.selected + 1, Math.max(0, activeList(state).length - 1)),
      });
    case 'k':
    case 'up':
      return clampScroll({ ...state, selected: Math.max(0, state.selected - 1) });
    case 'home':
    case 'g':
      return clampScroll({ ...state, selected: 0 });
    case 'end':
    case 'G':
      return clampScroll({ ...state, selected: Math.max(0, activeList(state).length - 1) });
    case 'page-down':
      return clampScroll({ ...state, selected: Math.min(state.selected + state.viewport, Math.max(0, activeList(state).length - 1)) });
    case 'page-up':
      return clampScroll({ ...state, selected: Math.max(0, state.selected - state.viewport) });
    case '[':
      return selectVault(state, -1);
    case ']':
      return selectVault(state, 1);
    case 'return':
    case 'l':
      return activeList(state).length ? { ...state, detail: true, bodyScroll: 0 } : state;
    default:
      return state;
  }
}

/**
 * Policy pane key handling. Returns `null` for keys it does not claim, so
 * `tab`, `q` and `r` keep their meaning and the pane is never a trap.
 *
 * Read-only until you press `e`. The pane shows the bound on non-interactive
 * signing, and a surface where the cursor resting on `deny_delegatecall` and a
 * stray keystroke could change it is not a surface for this file.
 */
function reducePolicy(state: TuiState, key: string): TuiState | null {
  const lines = state.policy ?? [];

  if (state.policyEdit !== null) {
    if (key === 'escape') return { ...state, policyEdit: null, policyCursor: undefined, policyError: undefined };
    if (key === 'return') return state;
    return editPolicy(state, key);
  }

  switch (key) {
    case 'j':
    case 'down':
      return { ...state, policyField: Math.min(state.policyField + 1, Math.max(0, lines.length - 1)) };
    case 'k':
    case 'up':
      return { ...state, policyField: Math.max(0, state.policyField - 1) };
    case 'e':
    case 'return':
      return lines.length ? { ...state, policyEdit: lines[state.policyField]?.value ?? '', policyCursor: undefined, policyError: undefined } : state;
    default:
      return null;
  }
}

/**
 * Form key handling.
 *
 * `field === -1` focuses the kind selector, so left/right pick the proposal
 * kind; from there `tab`/`return` walks into the fields. Escape always leaves,
 * because a form you cannot get out of is a trap.
 */
function reduceForm(state: TuiState, key: string): TuiState {
  const fields = FORM_FIELDS[state.form.kind];
  const { field } = state.form;

  if (key === 'escape') {
    return { ...state, pane: 'inbox', form: initialForm(state.form.kind), selected: 0, scroll: 0 };
  }

  if (field === -1) {
    switch (key) {
      case 'left':
      case 'h': {
        const at = PROPOSE_KINDS.indexOf(state.form.kind);
        const kind = PROPOSE_KINDS[(at - 1 + PROPOSE_KINDS.length) % PROPOSE_KINDS.length]!;
        return { ...state, form: initialForm(kind) };
      }
      case 'right':
      case 'l': {
        const at = PROPOSE_KINDS.indexOf(state.form.kind);
        const kind = PROPOSE_KINDS[(at + 1) % PROPOSE_KINDS.length]!;
        return { ...state, form: initialForm(kind) };
      }
      case 'return':
      case 'down':
        return { ...state, form: { ...state.form, field: 0, cursor: undefined } };
      default:
        return state;
    }
  }

  switch (key) {
    case 'tab':
    case 'down':
      return { ...state, form: { ...state.form, field: Math.min(field + 1, fields.length - 1), cursor: undefined } };
    case 'shift-tab':
    case 'up':
      return { ...state, form: { ...state.form, field: Math.max(-1, field - 1), cursor: undefined } };
    case 'return':
      // Enter on the last field is the submit gesture; the caller reads
      // `formArgv` and spawns. Anywhere else it advances.
      return field >= fields.length - 1
        ? state
        : { ...state, form: { ...state.form, field: field + 1, cursor: undefined } };
    default: return editForm(state, key);
  }
}

function scrollBody(state: TuiState, key: string): TuiState {
  const max = Math.max(0, state.bodyRows - state.viewport);
  const delta = ['j', 'down'].includes(key) ? 1 : ['k', 'up'].includes(key) ? -1 :
    key === 'page-down' ? state.viewport : key === 'page-up' ? -state.viewport : 0;
  const bodyScroll = ['g', 'home'].includes(key) ? 0 : ['G', 'end'].includes(key) ? max :
    Math.max(0, Math.min(max, state.bodyScroll + delta));
  return bodyScroll === state.bodyScroll ? state : { ...state, bodyScroll };
}

function printable(key: string): string | undefined {
  return Array.from(key).length === 1 && !/[\p{Cc}\p{Cf}]/u.test(key) ? key : undefined;
}
function editForm(state: TuiState, key: string, pasted?: string): TuiState {
  const field = FORM_FIELDS[state.form.kind][state.form.field];
  if (!field) return state;
  const insert = pasted ?? printable(key);
  if (insert === undefined && !EDIT_KEYS.has(key)) return state;
  const next = editText(state.form.values[field.name] ?? '', state.form.cursor, key, insert);
  const limit = fieldLimit(field.name);
  if (next.value.length > limit) return { ...state, form: { ...state.form,
    error: `Input too long for ${field.label} (max ${limit} characters) — nothing was inserted` } };
  return { ...state, form: { ...state.form, cursor: next.cursor,
    values: { ...state.form.values, [field.name]: next.value }, error: undefined } };
}
function editPolicy(state: TuiState, key: string, pasted?: string): TuiState {
  const insert = pasted ?? printable(key);
  if (insert === undefined && !EDIT_KEYS.has(key)) return state;
  const next = editText(state.policyEdit ?? '', state.policyCursor, key, insert);
  if (next.value.length > MAX_POLICY_LENGTH) return { ...state, policyError: `Input too long (max ${MAX_POLICY_LENGTH} characters) — nothing was inserted` };
  return { ...state, policyEdit: next.value, policyCursor: next.cursor, policyError: undefined };
}

/**
 * Insert pasted text into the focused form field.
 *
 * A paste is the *only* way most people enter an address — nobody types 42
 * hex characters — and it used to be dropped outright: Ink delivers a paste as
 * one multi-character `input`, and `mapKey` admitted single characters only.
 *
 * Ignored outside a focused field. The propose form is the one text input on
 * this surface, so a paste anywhere else should do nothing rather than
 * something surprising.
 */
function reducePaste(state: TuiState, text: string): TuiState {
  if (state.signing) return state;

  if (state.help) return state;
  const cleaned = text.replace(CONTROL_OR_FORMAT, '').trim();
  if (!cleaned) return state;
  if (state.searching) return { ...state, query: (state.query + cleaned).slice(0, 128), selected: 0, scroll: 0 };
  if (state.pane === 'policy' && !state.detail && state.policyEdit !== null) return editPolicy(state, '', cleaned);
  if (state.pane !== 'propose' || state.detail || state.form.field < 0) return state;
  return editForm(state, '', cleaned);
}

/** Fields the form still needs before it can be submitted. */
export function missingFields(form: FormState): string[] {
  return FORM_FIELDS[form.kind]
    .filter((f) => f.required && !(form.values[f.name] ?? '').trim())
    .map((f) => f.label);
}

/**
 * Turn the form into `qv propose …` argv. **This is the security boundary.**
 *
 * The TUI produces *arguments*, never calldata. The spawned one-shot child
 * parses them, builds the transaction, re-reads chain state and renders its
 * own §7 disclosure before anything is signed — so a bug in this function can
 * produce a wrong *proposal*, which the child will then show the user in full,
 * but it can never produce a signature over bytes nobody saw.
 *
 * Returns `null` when the form is incomplete, so the caller cannot spawn a
 * half-filled command.
 */
export function formArgv(form: FormState, vault: string): string[] | null {
  if (missingFields(form).length) return null;
  const v = (name: string): string => (form.values[name] ?? '').trim();
  if (form.kind === 'create-vault') {
    const argv = [
      'vault',
      'create',
      '--owner',
      ...v('owners').split(',').map((owner) => owner.trim()).filter(Boolean),
      '--threshold',
      v('threshold'),
    ];
    if (v('minDelay')) argv.push('--min-delay', v('minDelay'));
    return argv;
  }
  if (!vault) return null;
  if (form.kind === 'initiate-recovery') {
    return [
      'recovery',
      'initiate',
      vault,
      '--owner',
      ...v('owners').split(',').map((owner) => owner.trim()).filter(Boolean),
      '--threshold',
      v('threshold'),
    ];
  }
  const argv: string[] = ['propose', form.kind === 'abi-call' ? 'call' : form.kind, vault];

  switch (form.kind) {
    case 'transfer':
      argv.push('--to', v('to'), '--amount', v('amount'));
      break;
    case 'token':
      argv.push('--token', v('token'), '--to', v('to'), '--amount', v('amount'));
      if (v('decimals')) argv.push('--decimals', v('decimals'));
      break;
    case 'nft':
      argv.push('--token', v('token'), '--to', v('to'), '--token-id', v('tokenId'));
      break;
    case 'erc1155':
      argv.push('--token', v('token'), '--to', v('to'), '--token-id', v('tokenId'), '--amount', v('amount'));
      if (v('data')) argv.push('--data', v('data'));
      break;
    case 'call':
      argv.push('--to', v('to'), '--data', v('data'));
      if (v('value')) argv.push('--value', v('value'));
      break;
    case 'abi-call':
      argv.push('--to', v('to'), '--abi', v('abi'), '--function', v('function'));
      if (v('argsJson')) argv.push('--args-json', v('argsJson'));
      if (v('value')) argv.push('--value', v('value'));
      break;
    case 'batch':
      argv.push('--request', v('request'));
      break;
    case 'add-owner':
      argv.push(v('owner'));
      break;
    case 'remove-owner':
      argv.push(v('owner'));
      break;
    case 'threshold':
      argv.push(v('threshold'));
      break;
    case 'delay':
      argv.push(v('minDelay'));
      break;
    case 'module':
      argv.push(v('action'), v('module'));
      if (v('action') === 'enable' && v('acknowledge') === UNVERIFIED_ACK) {
        argv.push('--i-understand-unverified');
      }
      break;
    case 'delegatecall': {
      argv.push(v('action'), v('target'));
      // Only ever added when the user typed the acknowledgement, and only for
      // `add` — `rm` narrows the whitelist and needs no second gate. Without
      // it the spawned child refuses, which is the correct outcome: the flag
      // is a deliberate act, not a default the form supplies on your behalf.
      if (v('action') === 'add' && v('acknowledge') === UNVERIFIED_ACK) {
        argv.push('--i-understand-unverified');
      }
      break;
    }
    case 'cancel-by-consensus':
      argv.push(v('hash'));
      break;
    case 'sign-message':
      argv.push(v('message'));
      if (v('action') === 'unsign') argv.push('--unsign');
      break;
    case 'setup-recovery':
      argv.push(
        '--guardian',
        ...v('guardians').split(',').map((guardian) => guardian.trim()).filter(Boolean),
        '--threshold',
        v('threshold'),
        '--recovery-period',
        v('recoveryPeriod'),
      );
      break;
    default: {
      const never: never = form.kind;
      throw new Error(`unhandled propose kind: ${String(never)}`);
    }
  }

  if (v('idempotencyKey')) argv.push('--idempotency-key', v('idempotencyKey'));
  if (v('expiration')) argv.push('--expiration', v('expiration'));
  if (v('executionDelay')) argv.push('--execution-delay', v('executionDelay'));
  return argv;
}

export function selectedRow(state: TuiState): TuiRow | undefined {
  return activeList(state)[state.selected];
}

export function visibleRows(state: TuiState): TuiRow[] {
  return activeList(state).slice(state.scroll, state.scroll + state.viewport);
}

export function selectedVault(state: TuiState): VaultSummary | undefined {
  return state.vaults[state.selectedVault];
}
