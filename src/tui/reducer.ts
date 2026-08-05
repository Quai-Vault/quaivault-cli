import type { Affordance, VaultTransaction } from '@quaivault/sdk';
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

export type Pane = 'inbox' | 'history' | 'activity' | 'vault' | 'recovery' | 'propose';

/** Tab order. Monitoring panes first, the one that writes last. */
export const PANES: readonly Pane[] = [
  'inbox',
  'history',
  'activity',
  'vault',
  'recovery',
  'propose',
];

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
  owners: string[];
  threshold: number;
  minExecutionDelay: number;
  modules: string[];
  balanceWei: bigint;
}

export interface RecoveryDetail {
  hash: string;
  newOwners: string[];
  newThreshold: number;
  approvals: number;
  required: number;
  executableAt?: number;
  expiration?: number;
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
  | 'add-owner'
  | 'threshold'
  | 'delay'
  | 'delegatecall';

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
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
  ],
  'add-owner': [
    { name: 'owner', label: 'owner', hint: '0x… new owner', required: true },
    { name: 'expiration', label: 'expires', hint: '7d, 24h, or blank', required: false },
    { name: 'executionDelay', label: 'delay', hint: 'extra timelock, or blank', required: false },
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
};

export const PROPOSE_KINDS = Object.keys(FORM_FIELDS) as ProposeKind[];

export interface FormState {
  kind: ProposeKind;
  /** Index into FORM_FIELDS[kind]; `-1` means the kind selector is focused. */
  field: number;
  values: Record<string, string>;
  error?: string;
}

export function initialForm(kind: ProposeKind = 'transfer'): FormState {
  return { kind, field: -1, values: {} };
}

// ------------------------------------------------------------------- state

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
  recovery: RecoveryDetail | null;
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
}

export type TuiEvent =
  | { type: 'key'; key: string }
  | { type: 'paste'; text: string }
  | { type: 'resize'; rows: number }
  | { type: 'data'; rows: TuiRow[]; degraded: boolean; at: number }
  | { type: 'vaults'; vaults: VaultSummary[] }
  | { type: 'history'; rows: TuiRow[] }
  | { type: 'vault-detail'; detail: VaultDetail | null }
  | { type: 'recovery'; detail: RecoveryDetail | null }
  | { type: 'activity'; entry: ActivityEntry }
  | { type: 'loading' }
  | { type: 'error'; message: string }
  | { type: 'sign-start'; hash: string; action: string }
  | { type: 'sign-end'; ok: boolean; message: string };

/** Bounded so a busy vault cannot grow the activity log without limit. */
export const ACTIVITY_LIMIT = 200;

/**
 * Longest value a field will hold.
 *
 * Typing is self-limiting; a paste is not, and the clipboard can hold a
 * megabyte. The longest thing any field legitimately takes is a 42-character
 * address, so this is generous rather than tight.
 */
export const MAX_FIELD_LENGTH = 128;

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
    recovery: null,
    selected: 0,
    scroll: 0,
    viewport,
    load: { status: 'idle' },
    holdsKey: false,
    signing: null,
    lastSignResult: null,
    form: initialForm(),
    quit: false,
  };
}

/** The list the current pane is navigating, if it navigates one at all. */
export function activeList(state: TuiState): TuiRow[] {
  if (state.pane === 'history') return state.history;
  if (state.pane === 'inbox') return state.rows;
  return [];
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
  const anchor = before[state.selected]?.tx.hash;
  const moved = anchor ? after.findIndex((r) => r.tx.hash === anchor) : -1;
  return moved >= 0 ? moved : Math.min(state.selected, Math.max(0, after.length - 1));
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

export function reduce(state: TuiState, event: TuiEvent): TuiState {
  switch (event.type) {
    case 'loading':
      return { ...state, load: { ...state.load, status: 'loading' } };

    case 'data': {
      const selected = reselect(state, 'inbox', state.rows, event.rows);
      return clampScroll({
        ...state,
        rows: event.rows,
        selected,
        // "no results" and "cannot see results" are different things, and the
        // difference must survive a refresh.
        load: { status: event.degraded ? 'degraded' : 'ok', fetchedAt: event.at },
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
        vaults: event.vaults,
        selectedVault:
          moved >= 0 ? moved : Math.min(state.selectedVault, Math.max(0, event.vaults.length - 1)),
      };
    }

    case 'history':
      return clampScroll({
        ...state,
        history: event.rows,
        selected: reselect(state, 'history', state.history, event.rows),
      });

    case 'vault-detail':
      return { ...state, vaultDetail: event.detail };

    case 'recovery':
      return { ...state, recovery: event.detail };

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
  return clampScroll({ ...state, pane: next, detail: false, selected: 0, scroll: 0 });
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
    detail: false,
    selected: state.pane === 'inbox' ? state.selected : 0,
    scroll: state.pane === 'inbox' ? state.scroll : 0,
    history: [],
    vaultDetail: null,
    recovery: null,
  });
}

function reduceKey(state: TuiState, key: string): TuiState {
  // While a spawned signer owns the terminal, the TUI ignores input entirely.
  if (state.signing) return state;

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
    case 'g':
      return clampScroll({ ...state, selected: 0 });
    case 'G':
      return clampScroll({ ...state, selected: Math.max(0, activeList(state).length - 1) });
    case '[':
      return selectVault(state, -1);
    case ']':
      return selectVault(state, 1);
    case 'return':
    case 'l':
      return activeList(state).length ? { ...state, detail: true } : state;
    default:
      return state;
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
        return { ...state, form: { ...state.form, field: 0 } };
      default:
        return state;
    }
  }

  switch (key) {
    case 'tab':
    case 'down':
      return { ...state, form: { ...state.form, field: Math.min(field + 1, fields.length - 1) } };
    case 'shift-tab':
    case 'up':
      return { ...state, form: { ...state.form, field: Math.max(-1, field - 1) } };
    case 'return':
      // Enter on the last field is the submit gesture; the caller reads
      // `formArgv` and spawns. Anywhere else it advances.
      return field >= fields.length - 1
        ? state
        : { ...state, form: { ...state.form, field: field + 1 } };
    case 'backspace': {
      const name = fields[field]!.name;
      const current = state.form.values[name] ?? '';
      return {
        ...state,
        form: {
          ...state.form,
          values: { ...state.form.values, [name]: current.slice(0, -1) },
          error: undefined,
        },
      };
    }
    case 'ctrl-u': {
      const name = fields[field]!.name;
      return {
        ...state,
        form: { ...state.form, values: { ...state.form.values, [name]: '' }, error: undefined },
      };
    }
    default: {
      // Printable single characters are content. Anything longer is a key name
      // we do not handle, and must not be typed into the field.
      if (key.length !== 1 || key < ' ') return state;
      const name = fields[field]!.name;
      const current = state.form.values[name] ?? '';
      return {
        ...state,
        form: {
          ...state.form,
          values: { ...state.form.values, [name]: current + key },
          error: undefined,
        },
      };
    }
  }
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
  if (state.pane !== 'propose' || state.detail || state.form.field < 0) return state;

  const field = FORM_FIELDS[state.form.kind][state.form.field];
  if (!field) return state;

  const cleaned = text.replace(CONTROL_OR_FORMAT, '').trim();
  if (!cleaned) return state;

  const next = (state.form.values[field.name] ?? '') + cleaned;
  if (next.length > MAX_FIELD_LENGTH) {
    // Refused, not truncated. A silently shortened address is still a
    // plausible-looking address, and this form feeds `qv propose`.
    return {
      ...state,
      form: {
        ...state.form,
        error: `that paste is too long for ${field.label} (max ${MAX_FIELD_LENGTH} characters) — nothing was inserted`,
      },
    };
  }

  return {
    ...state,
    form: {
      ...state.form,
      values: { ...state.form.values, [field.name]: next },
      error: undefined,
    },
  };
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
  const argv: string[] = ['propose', form.kind, vault];

  switch (form.kind) {
    case 'transfer':
      argv.push('--to', v('to'), '--amount', v('amount'));
      break;
    case 'token':
      argv.push('--token', v('token'), '--to', v('to'), '--amount', v('amount'));
      break;
    case 'add-owner':
      argv.push(v('owner'));
      break;
    case 'threshold':
      argv.push(v('threshold'));
      break;
    case 'delay':
      argv.push(v('minDelay'));
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
    default: {
      const never: never = form.kind;
      throw new Error(`unhandled propose kind: ${String(never)}`);
    }
  }

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
