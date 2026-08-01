import { decodeCall, decodeMultiSendPayload, interfaces, Operation } from '@quaivault/sdk';
import type { AbiLookup, AbiSource, ContractAddresses, DecodedCall } from '@quaivault/sdk';

/**
 * Batch disclosure (plan §7, "Batch recurses").
 *
 * `propose.batch` decodes to `"Batched call: N sub-transactions"` and nothing
 * else, so without this a co-signer approving a batch sees a count and no
 * content — the blind-signing failure mode in Appendix A, reproduced exactly.
 *
 * **This is also the only place a delegatecall can be detected.** The vault's
 * transaction struct has no `operation` field: `RawTransactionStruct` is
 * `{to, timestamp, expiration, proposer, executed, cancelled, approvedAt,
 * executionDelay, value, data}`, so a top-level vault transaction is
 * structurally always a CALL. DelegateCall exists only inside a MultiSend
 * payload, where each entry carries its own operation byte. §7's rule that
 * "an inner delegatecall trips the gate even when the outer operation is 0"
 * is therefore not an edge case — it is the whole of the delegatecall gate.
 *
 * Pure and I/O-free, so both `tx show` and the pre-signature path can call it
 * and be guaranteed to render the same thing.
 */

export interface SubCall {
  /** Position in the batch, 0-based, as encoded. */
  index: number;
  operation: number;
  isDelegatecall: boolean;
  to: string;
  value: bigint;
  data: string;
  summary: string;
  abiSource: AbiSource;
  decoded?: DecodedCall;
}

export interface BatchAnalysis {
  calls: SubCall[];
  /** True when any sub-call is a delegatecall, at any position. */
  hasDelegatecall: boolean;
  /** The least trustworthy provenance across all sub-calls. */
  abiSource: AbiSource;
  /**
   * Set when the payload could not be unpacked. The batch is then reported as
   * unverified regardless of anything else — see `isUnverified`.
   */
  error?: string;
}

export interface BatchInput {
  vault: string;
  to: string;
  data: string;
  contracts: ContractAddresses;
  abis?: AbiLookup;
}

/**
 * Provenance ordered worst-last, so `abiSource` for a batch is the weakest
 * link. A batch of nine builtin calls and one guess is a guess.
 */
const TRUST_ORDER: AbiSource[] = ['builtin', 'supplied', 'heuristic', 'none'];

/**
 * Widened to `number` deliberately: the operation byte arrives from
 * attacker-influenceable calldata, so it is an arbitrary number that happens
 * to sometimes equal a known one — not a value of the enum type.
 */
const DELEGATECALL: number = Operation.DelegateCall;

function weakest(sources: AbiSource[]): AbiSource {
  let worst: AbiSource = 'builtin';
  for (const s of sources) {
    if (TRUST_ORDER.indexOf(s) > TRUST_ORDER.indexOf(worst)) worst = s;
  }
  return worst;
}

/** The `multiSend(bytes)` selector, taken from the ABI rather than hardcoded. */
function multiSendSelector(): string {
  return interfaces.multiSend.getFunction('multiSend')!.selector;
}

/**
 * Returns `null` when this is not a batch at all. Everything else — including
 * a batch we could not parse — comes back as an analysis, because "this is a
 * batch and we cannot read it" must be sayable.
 */
export function analyzeBatch(input: BatchInput): BatchAnalysis | null {
  const data = input.data ?? '0x';
  if (data.length < 10) return null;
  if (data.slice(0, 10).toLowerCase() !== multiSendSelector().toLowerCase()) return null;

  // A MultiSend selector aimed somewhere other than the known MultiSendCallOnly
  // deployment is worth rendering as a batch anyway: the reviewer should see
  // the sub-calls of whatever they are being asked to approve, and the `to`
  // address is disclosed separately for them to judge.

  let payload: string;
  try {
    const [arg] = interfaces.multiSend.decodeFunctionData('multiSend', data) as unknown as [
      string,
    ];
    payload = arg;
  } catch (err) {
    return failed(`the multiSend calldata did not decode: ${describe(err)}`);
  }

  let entries: { operation: number; to: string; value: bigint; data: string }[];
  try {
    entries = decodeMultiSendPayload(payload);
  } catch (err) {
    return failed(`the batch payload did not unpack: ${describe(err)}`);
  }

  // **The decoder is lenient and we must not be.** `decodeMultiSendPayload`
  // stops when the remaining bytes are too short for another entry and
  // reports no error: a truncated entry yields `[]`, a length field that
  // overruns the buffer yields `[]`, and a valid entry followed by junk
  // yields just the valid entry. All three verified against 0.6.0.
  //
  // Any of them means the bytes the vault will hand to MultiSend are not the
  // bytes we just described to a human. Disclosing N sub-calls while the
  // chain executes something else is the failure this whole file exists to
  // prevent, so the payload must be accounted for exactly, to the byte.
  const declared = byteLength(payload);
  const consumed = entries.reduce((n, e) => n + 1 + 20 + 32 + 32 + byteLength(e.data), 0);
  if (consumed !== declared) {
    return failed(
      `the batch payload is ${declared} bytes but only ${consumed} decode as sub-calls — ` +
        `${declared - consumed} unaccounted for`,
    );
  }

  const calls: SubCall[] = entries.map((entry, index) => {
    let summary = '(could not decode)';
    let abiSource: AbiSource = 'none';
    let decoded: DecodedCall | undefined;
    try {
      const result = decodeCall({
        vault: input.vault,
        to: entry.to,
        value: entry.value,
        data: entry.data,
        ...(input.contracts.socialRecovery ? { socialRecovery: input.contracts.socialRecovery } : {}),
        ...(input.contracts.multiSendCallOnly
          ? { multiSendCallOnly: input.contracts.multiSendCallOnly }
          : {}),
        ...(input.abis ? { abis: input.abis } : {}),
      });
      summary = result.summary;
      abiSource = result.abiSource;
      decoded = result.decoded;
    } catch {
      // A sub-call the SDK cannot describe is not an error condition — §7.1
      // says render the hex, which the caller does from `data`. It is only a
      // provenance of `none`.
    }
    return {
      index,
      operation: entry.operation,
      isDelegatecall: entry.operation === DELEGATECALL,
      to: entry.to,
      value: entry.value,
      data: entry.data,
      summary,
      abiSource,
      ...(decoded ? { decoded } : {}),
    };
  });

  return {
    calls,
    hasDelegatecall: calls.some((c) => c.isDelegatecall),
    abiSource: weakest(calls.map((c) => c.abiSource)),
  };
}

/**
 * Fail closed. An unparseable batch reports no sub-calls, the weakest possible
 * provenance, and — deliberately — `hasDelegatecall: true`.
 *
 * That last one looks like lying and is not. The question the gate asks is
 * "could this contain a delegatecall?", and for a payload we could not read
 * the honest answer is yes. Reporting `false` would let a batch nobody can
 * decode past a policy whose entire purpose is stopping exactly that.
 */
function failed(error: string): BatchAnalysis {
  return { calls: [], hasDelegatecall: true, abiSource: 'none', error };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function byteLength(hex: string): number {
  const body = hex.replace(/^0x/, '');
  return Math.floor(body.length / 2);
}

/**
 * The §7 gate, in one place so the renderer, the policy check and the
 * confirmation prompt cannot disagree about what counts as unverified.
 *
 * Mechanical rather than prose, per §7: a second explicit flag is required
 * whenever the decode is not one the SDK vouches for, **or** anything in it is
 * a delegatecall, **or** a decode failed.
 */
export function isUnverified(outerAbiSource: AbiSource, batch: BatchAnalysis | null): boolean {
  if (outerAbiSource !== 'builtin') return true;
  if (!batch) return false;
  return batch.error !== undefined || batch.hasDelegatecall || batch.abiSource !== 'builtin';
}
