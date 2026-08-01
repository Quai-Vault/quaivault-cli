import { describe, it, expect } from 'vitest';
import { encodeMultiSendPayload, Operation } from '@quaivault/sdk';
import type { ContractAddresses } from '@quaivault/sdk';
import { analyzeBatch, isUnverified } from '../../src/abi/batch.js';
import {
  batchOf as batchOfEntries,
  erc20Transfer,
  multiSendCalldata,
  multiSendEntry as entry,
} from '../fake-client.js';

/**
 * Batch disclosure (plan §7, "Batch recurses").
 *
 * These build real MultiSend payloads rather than mocking the decode, because
 * the thing under test *is* the byte layout: `operation(1) ‖ to(20) ‖
 * value(32) ‖ dataLength(32) ‖ data`. A mock would pass while the parser read
 * the operation byte from the wrong offset.
 *
 * The delegatecall cases are hand-encoded on purpose. `encodeMultiSendPayload`
 * always writes operation 0 — MultiSendCallOnly rejects nested delegatecall —
 * so the SDK's encoder cannot produce the input this gate exists to catch. An
 * attacker-authored proposal is under no such constraint, and a proposal is
 * free to target a MultiSend-like contract that does honour operation 1.
 */

const VAULT = '0x0071f4e8a9b0c1d2e3f405162738495a6b7c8d78';
const ALICE = '0x0072a1b2c3d4e5f60718293a4b5c6d7e8f901234';
const EVIL = '0x0073deadbeefdeadbeefdeadbeefdeadbeefdead';

const CONTRACTS: ContractAddresses = {
  implementation: '0x0074000000000000000000000000000000000001',
  factory: '0x0074000000000000000000000000000000000002',
  socialRecovery: '0x0074000000000000000000000000000000000003',
  multiSendCallOnly: '0x0074000000000000000000000000000000000004',
};

describe('analyzeBatch — detection', () => {
  it('returns null for a plain call', () => {
    expect(
      analyzeBatch({ vault: VAULT, to: ALICE, data: '0x', contracts: CONTRACTS }),
    ).toBeNull();
    expect(
      analyzeBatch({
        vault: VAULT,
        to: ALICE,
        data: erc20Transfer(ALICE, 1n),
        contracts: CONTRACTS,
      }),
    ).toBeNull();
  });

  it('returns null for calldata too short to carry a selector', () => {
    expect(analyzeBatch({ vault: VAULT, to: ALICE, data: '0xabcd', contracts: CONTRACTS })).toBeNull();
  });

  it('recognises a batch by selector regardless of the target address', () => {
    // A MultiSend selector aimed somewhere other than the known deployment is
    // still something the reviewer must see the sub-calls of. Refusing to
    // recurse because `to` was unfamiliar would hide exactly the case worth
    // showing.
    const data = batchOfEntries(entry(0, ALICE, 1n, '0x'));
    const known = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    const unknown = analyzeBatch({ vault: VAULT, to: EVIL, data, contracts: CONTRACTS });
    expect(known?.calls).toHaveLength(1);
    expect(unknown?.calls).toHaveLength(1);
  });
});

describe('analyzeBatch — sub-call decoding', () => {
  it('unpacks every sub-call with its own to, value and data', () => {
    const data = batchOfEntries(
      entry(0, ALICE, 5n, '0x'),
      entry(0, EVIL, 0n, erc20Transfer(ALICE, 42n)),
    );
    const batch = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    expect(batch).not.toBeNull();
    expect(batch!.calls).toHaveLength(2);

    expect(batch!.calls[0]!.index).toBe(0);
    expect(batch!.calls[0]!.to.toLowerCase()).toBe(ALICE);
    expect(batch!.calls[0]!.value).toBe(5n);
    expect(batch!.calls[0]!.data).toBe('0x');

    expect(batch!.calls[1]!.index).toBe(1);
    expect(batch!.calls[1]!.to.toLowerCase()).toBe(EVIL);
    expect(batch!.calls[1]!.data).toBe(erc20Transfer(ALICE, 42n));
  });

  it('round-trips against the SDK’s own encoder', () => {
    // Guards the hand-packing above: if the SDK's layout ever changed, this
    // fails and the hand-built fixtures are revealed as wrong rather than
    // silently testing a format nobody uses.
    const payload = encodeMultiSendPayload([
      { to: ALICE, value: 7n },
      { to: EVIL, data: erc20Transfer(ALICE, 3n) },
    ]);
    const batch = analyzeBatch({
      vault: VAULT,
      to: CONTRACTS.multiSendCallOnly!,
      data: multiSendCalldata(payload),
      contracts: CONTRACTS,
    });
    expect(batch!.calls).toHaveLength(2);
    expect(batch!.calls[0]!.value).toBe(7n);
    const CALL: number = Operation.Call;
    expect(batch!.calls.every((c) => c.operation === CALL)).toBe(true);
  });

  it('handles an empty batch without inventing sub-calls', () => {
    const batch = analyzeBatch({
      vault: VAULT,
      to: CONTRACTS.multiSendCallOnly!,
      data: multiSendCalldata('0x'),
      contracts: CONTRACTS,
    });
    expect(batch!.calls).toEqual([]);
    expect(batch!.hasDelegatecall).toBe(false);
  });
});

describe('analyzeBatch — the delegatecall gate', () => {
  it('flags an inner delegatecall even when it is not the first sub-call', () => {
    // §7: "an inner delegatecall trips the gate even when the outer operation
    // is 0" — and the outer operation is *always* 0, because the vault's
    // transaction struct has no operation field at all. This is the only
    // detection point that exists.
    const data = batchOfEntries(
      entry(0, ALICE, 1n, '0x'),
      entry(0, ALICE, 2n, '0x'),
      entry(1, EVIL, 0n, '0xdeadbeef'),
    );
    const batch = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    expect(batch!.hasDelegatecall).toBe(true);
    expect(batch!.calls[2]!.isDelegatecall).toBe(true);
    expect(batch!.calls[0]!.isDelegatecall).toBe(false);
  });

  it('reports no delegatecall when there is none', () => {
    const data = batchOfEntries(entry(0, ALICE, 1n, '0x'), entry(0, EVIL, 0n, '0x1234'));
    const batch = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    expect(batch!.hasDelegatecall).toBe(false);
  });
});

describe('analyzeBatch — failing closed', () => {
  it('reports a truncated payload as unreadable and assumes the worst', () => {
    // A batch whose bytes we cannot parse must never be waved through. The
    // question the gate asks is "could this contain a delegatecall?", and for
    // an unreadable payload the honest answer is yes.
    const truncated = entry(0, ALICE, 1n, '0xdeadbeef').slice(0, 40);
    const batch = analyzeBatch({
      vault: VAULT,
      to: CONTRACTS.multiSendCallOnly!,
      data: multiSendCalldata('0x' + truncated),
      contracts: CONTRACTS,
    });
    expect(batch).not.toBeNull();
    expect(batch!.error).toBeTruthy();
    expect(batch!.hasDelegatecall).toBe(true);
    expect(batch!.abiSource).toBe('none');
    expect(batch!.calls).toEqual([]);
  });

  it('reports a sub-call length field that overruns the buffer', () => {
    // dataLength claims 0xff bytes; the payload supplies none.
    const lying = '00' + ALICE.slice(2) + '0'.repeat(64) + 'ff'.padStart(64, '0');
    const batch = analyzeBatch({
      vault: VAULT,
      to: CONTRACTS.multiSendCallOnly!,
      data: multiSendCalldata('0x' + lying),
      contracts: CONTRACTS,
    });
    expect(batch!.error ?? '').toBeTruthy();
    expect(batch!.hasDelegatecall).toBe(true);
  });

  it('refuses a payload with bytes trailing a perfectly valid sub-call', () => {
    // The nastiest of the three, because the decode *succeeds*. The SDK
    // returns the one good entry and silently discards the rest, so a naive
    // disclosure shows one sub-call for a blob the chain reads differently.
    const valid = entry(0, ALICE, 0n, '0x');
    const batch = analyzeBatch({
      vault: VAULT,
      to: CONTRACTS.multiSendCallOnly!,
      data: multiSendCalldata('0x' + valid + 'abcd'),
      contracts: CONTRACTS,
    });
    expect(batch!.error).toMatch(/unaccounted for/);
    expect(batch!.hasDelegatecall).toBe(true);
    expect(batch!.calls).toEqual([]);
  });

  it('accepts a payload that is accounted for to the byte', () => {
    // The other half of the check: exact accounting must not reject valid
    // input, including sub-calls with odd-length data.
    const data = batchOfEntries(
      entry(0, ALICE, 0n, '0x'),
      entry(0, EVIL, 1n, '0xdeadbeef'),
      entry(0, ALICE, 2n, erc20Transfer(EVIL, 9n)),
    );
    const batch = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    expect(batch!.error).toBeUndefined();
    expect(batch!.calls).toHaveLength(3);
  });
});

describe('analyzeBatch — provenance is the weakest link', () => {
  it('reports the least trustworthy sub-call provenance for the batch', () => {
    // A batch of nine calls the SDK vouches for and one guess is a guess.
    const data = batchOfEntries(
      entry(0, ALICE, 0n, erc20Transfer(ALICE, 1n)),
      entry(0, EVIL, 0n, '0xdeadbeef'),
    );
    const batch = analyzeBatch({ vault: VAULT, to: CONTRACTS.multiSendCallOnly!, data, contracts: CONTRACTS });
    expect(batch!.calls.map((c) => c.abiSource)).toContain(batch!.abiSource);
    expect(batch!.abiSource).not.toBe('builtin');
  });
});

describe('isUnverified — the §7 gate, mechanically', () => {
  const clean = { calls: [], hasDelegatecall: false, abiSource: 'builtin' as const };

  it('trips when the outer decode is not builtin, batch or not', () => {
    expect(isUnverified('heuristic', null)).toBe(true);
    expect(isUnverified('supplied', null)).toBe(true);
    expect(isUnverified('none', null)).toBe(true);
    expect(isUnverified('heuristic', clean)).toBe(true);
  });

  it('does not trip on a plain builtin call', () => {
    expect(isUnverified('builtin', null)).toBe(false);
    expect(isUnverified('builtin', clean)).toBe(false);
  });

  it('trips on an inner delegatecall behind a builtin outer decode', () => {
    // The case the whole mechanism exists for: `multiSend(bytes)` decodes
    // builtin every time, so without recursion this reads as safe.
    expect(isUnverified('builtin', { ...clean, hasDelegatecall: true })).toBe(true);
  });

  it('trips on a weak sub-call provenance behind a builtin outer decode', () => {
    expect(isUnverified('builtin', { ...clean, abiSource: 'none' })).toBe(true);
    expect(isUnverified('builtin', { ...clean, abiSource: 'heuristic' })).toBe(true);
  });

  it('trips on an unreadable batch', () => {
    expect(isUnverified('builtin', { ...clean, error: 'nope' })).toBe(true);
  });
});
