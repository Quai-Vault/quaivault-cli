import { describe, expect, it } from 'vitest';
import { createBufferIo } from '../../src/render/io.js';
import { renderCalldata, renderDisclosure, txToJson } from '../../src/render/transaction.js';
import {
  ADDR,
  batchOfTwo,
  batchWithDelegatecall,
  createFakeContext,
  fakeTx,
  unreadableBatch,
} from '../fake-client.js';
import { jsonSafe } from '../../src/util/json.js';

const io = () => createBufferIo(100);

describe('unknown ABI renders the hex — always', () => {
  const transfer = `0xa9059cbb${'0'.repeat(24)}${'11'.repeat(20)}${'0'.repeat(62)}64`;

  it('shows the full calldata, untruncated, word per line', () => {
    const b = io();
    renderCalldata(transfer, b, true);
    const text = b.stdout.join('\n');
    expect(text).toContain('unknown ABI');
    expect(text).toContain('selector  0xa9059cbb');
    expect(text).toContain('[000]');
    expect(text).toContain('[032]');
    expect(text).not.toContain('…');
    // Every byte of the payload is present.
    expect(text).toContain('11'.repeat(20));
  });

  it('states the byte length so an oversized payload is visible', () => {
    const b = io();
    renderCalldata(transfer, b, true);
    expect(b.stdout.join('\n')).toContain('68 bytes');
  });

  it('warns when the payload is not a whole number of 32-byte words', () => {
    const b = io();
    renderCalldata('0xa9059cbbdeadbeef', b, true);
    expect(b.stdout.join('\n')).toMatch(/not a whole number of 32-byte words/);
  });

  it('says "(none)" rather than printing an empty block', () => {
    const b = io();
    renderCalldata('0x', b, false);
    expect(b.stdout.join('\n')).toContain('(none)');
  });
});

describe('pre-signature disclosure', () => {
  it('prints the full address, not a shortened one', () => {
    const ctx = createFakeContext();
    const b = io();
    renderDisclosure(fakeTx(), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain(ADDR.alice);
    expect(text).toContain(fakeTx().hash);
  });

  it('shows the value in both QUAI and exact wei', () => {
    const ctx = createFakeContext();
    const b = io();
    renderDisclosure(fakeTx({ value: 100_000_000_000_000_000_000n }), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain('100 QUAI');
    expect(text).toContain('100000000000000000000 wei');
  });

  it('renders a heuristic decode differently from a verified one', () => {
    const ctx = createFakeContext();
    const verified = io();
    renderDisclosure(fakeTx({ abiSource: 'builtin' }), verified, ctx);
    const guessed = io();
    renderDisclosure(fakeTx({ abiSource: 'heuristic' }), guessed, ctx);
    expect(verified.stdout.join('\n')).not.toBe(guessed.stdout.join('\n'));
    expect(guessed.stdout.join('\n')).toMatch(/guessed from selector/);
    expect(guessed.stdout.join('\n')).toMatch(/does not know what contract/);
  });

  it('shows who has NOT signed, not just who has', () => {
    const ctx = createFakeContext({ contacts: { bob: ADDR.bob, alice: ADDR.alice } });
    const b = io();
    renderDisclosure(fakeTx(), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain('[x]');
    expect(text).toContain('[ ]');
    expect(text).toContain('bob');
    expect(text).toContain('alice');
  });

  it('flags a delegatecall inside a batch in the strongest terms available', () => {
    // This test used to pass a synthetic `operation: 1` on the transaction
    // itself, which no VaultTransaction has ever carried -- the vault's
    // struct has no operation field. It was asserting against a shape the
    // renderer invented, and it went green while the real delegatecall gate
    // never fired. The only place an operation byte exists is a MultiSend
    // sub-call, so that is what this builds.
    const ctx = createFakeContext();
    const b = io();
    renderDisclosure(fakeTx({ data: batchWithDelegatecall(), kind: 'batched_call' }), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain('DELEGATECALL');
    expect(text).toMatch(/rewrite vault storage/);
  });

  it('renders every sub-call of a batch, not just the count', () => {
    // §7 "Batch recurses". Without this a reviewer sees "Batched call: N
    // sub-transactions" and approves N things they were never shown.
    const ctx = createFakeContext();
    const b = io();
    renderDisclosure(fakeTx({ data: batchOfTwo(), kind: 'batched_call' }), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain('2 sub-transactions');
    expect(text).toContain('[1/2]');
    expect(text).toContain('[2/2]');
    expect(text.toLowerCase()).toContain(ADDR.carol.toLowerCase());
  });

  it('says so loudly when a batch payload cannot be read', () => {
    const ctx = createFakeContext();
    const b = io();
    renderDisclosure(fakeTx({ data: unreadableBatch(), kind: 'batched_call' }), b, ctx);
    const text = b.stdout.join('\n');
    expect(text).toContain('UNREADABLE');
    expect(text).toMatch(/Treated as containing a delegatecall/);
  });
});

describe('transaction JSON', () => {
  it('never emits a prose age — the consumer does its own arithmetic', () => {
    const json = jsonSafe(txToJson(fakeTx(), 9_272_855)) as Record<string, unknown>;
    expect(JSON.stringify(json)).not.toMatch(/ago/);
    expect(json.proposedAtBlock).toBe(9_272_800);
    expect(json.chainHead).toBe(9_272_855);
    expect(json.proposedAtApproximate).toBe(true);
  });

  it('carries the raw calldata, its length and its selector', () => {
    const json = txToJson(fakeTx({ data: '0xa9059cbb' }), 1);
    expect(json.data).toBe('0xa9059cbb');
    expect(json.dataLength).toBe(4);
    expect(json.selector).toBe('0xa9059cbb');
  });

  it('serializes value as a decimal wei string', () => {
    const json = jsonSafe(txToJson(fakeTx({ value: 5n }), 1)) as Record<string, unknown>;
    expect(json.value).toBe('5');
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

describe('Io stream discipline', () => {
  it('keeps data and chrome on separate streams', () => {
    const b = io();
    b.out('data');
    b.err('warning');
    expect(b.stdout).toEqual(['data']);
    expect(b.stderr).toEqual(['warning']);
  });

  it('never colours when colour is disabled', () => {
    const b = io();
    expect(b.paint({ text: 'x', tone: 'danger' })).toBe('x');
  });
});
