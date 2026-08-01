import { describe, expect, it, vi } from 'vitest';
import type { WatchEvent } from '@quaivault/sdk';
import { ChangeFeed, ResultStore, cacheKey } from '../../src/store/index.js';

const event = (over: Partial<WatchEvent> = {}): WatchEvent => ({
  topic: 'transactions',
  table: 'transactions',
  type: 'INSERT',
  row: null,
  previous: null,
  ...over,
});

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (by: number) => (t += by) };
}

describe('ResultStore', () => {
  it('returns a cached value without re-running the producer', async () => {
    const store = new ResultStore(clock().now);
    const produce = vi.fn().mockResolvedValue('one');
    expect(await store.resolve('k', produce)).toBe('one');
    expect(await store.resolve('k', produce)).toBe('one');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent callers into one execution', async () => {
    // The property that makes this worth having in the one-shot surface:
    // `inbox` fans out across vaults and asks several call sites for the same
    // vault info at once.
    const store = new ResultStore(clock().now);
    let resolveIt: (v: string) => void = () => undefined;
    const produce = vi.fn(() => new Promise<string>((r) => (resolveIt = r)));
    const a = store.resolve('k', produce);
    const b = store.resolve('k', produce);
    resolveIt('shared');
    expect(await a).toBe('shared');
    expect(await b).toBe('shared');
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it('never caches a rejection', async () => {
    // A failed read must not poison the key until something invalidates it —
    // otherwise one indexer blip makes a command permanently degraded for the
    // life of the process.
    const store = new ResultStore(clock().now);
    const produce = vi
      .fn()
      .mockRejectedValueOnce(new Error('indexer down'))
      .mockResolvedValueOnce('recovered');
    await expect(store.resolve('k', produce)).rejects.toThrow('indexer down');
    expect(await store.resolve('k', produce)).toBe('recovered');
    expect(produce).toHaveBeenCalledTimes(2);
  });

  it('treats a stale entry as a miss but still exposes it to peek', async () => {
    const store = new ResultStore(clock().now);
    await store.resolve('k', () => Promise.resolve('v'), { topics: ['transactions'] });
    store.markStale(() => true);
    expect(store.get('k')).toBeUndefined();
    // Rendering last-known data while a refresh runs is the reason peek exists.
    expect(store.peek<string>('k')?.value).toBe('v');
    expect(store.peek('k')?.stale).toBe(true);
  });

  it('re-runs the producer once an entry is stale', async () => {
    const store = new ResultStore(clock().now);
    const produce = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    await store.resolve('k', produce);
    store.markStale(() => true);
    expect(await store.resolve('k', produce)).toBe('second');
  });

  it('expires an entry on its ttl using the injected clock', async () => {
    const c = clock();
    const store = new ResultStore(c.now);
    const produce = vi.fn().mockResolvedValueOnce('a').mockResolvedValueOnce('b');
    expect(await store.resolve('k', produce, { ttl: 30 })).toBe('a');
    c.advance(29);
    expect(await store.resolve('k', produce, { ttl: 30 })).toBe('a');
    c.advance(1);
    expect(await store.resolve('k', produce, { ttl: 30 })).toBe('b');
  });

  it('notifies subscribers with the keys that changed', async () => {
    const store = new ResultStore(clock().now);
    const seen: string[][] = [];
    const off = store.subscribe((keys) => seen.push(keys));
    await store.resolve('a', () => Promise.resolve(1), { topics: ['owners'] });
    await store.resolve('b', () => Promise.resolve(2), { topics: ['transactions'] });
    store.markStale((e) => e.topics.includes('owners'));
    expect(seen).toEqual([['a']]);
    off();
    store.markStale(() => true);
    expect(seen).toHaveLength(1);
  });

  it('marks an entry stale only once, so a repeat event is not a repeat refresh', async () => {
    const store = new ResultStore(clock().now);
    await store.resolve('a', () => Promise.resolve(1), { topics: ['transactions'] });
    expect(store.markStale(() => true)).toEqual(['a']);
    expect(store.markStale(() => true)).toEqual([]);
  });

  it('drops entries outright on invalidate', async () => {
    const store = new ResultStore(clock().now);
    await store.resolve('a', () => Promise.resolve(1));
    expect(store.invalidate(() => true)).toEqual(['a']);
    expect(store.peek('a')).toBeUndefined();
    expect(store.size).toBe(0);
  });
});

describe('ChangeFeed', () => {
  it('marks matching topics stale and leaves others alone', async () => {
    const store = new ResultStore(clock().now);
    const feed = new ChangeFeed(store);
    await store.resolve('txs', () => Promise.resolve(1), {
      topics: ['transactions'],
      vault: '0xAAA',
    });
    await store.resolve('owners', () => Promise.resolve(2), {
      topics: ['owners'],
      vault: '0xAAA',
    });
    expect(feed.push('0xaaa', event({ topic: 'transactions' }))).toEqual(['txs']);
    expect(store.get('owners')).toBe(2);
  });

  it('scopes invalidation to the vault the event came from', async () => {
    const store = new ResultStore(clock().now);
    const feed = new ChangeFeed(store);
    await store.resolve('a', () => Promise.resolve(1), {
      topics: ['transactions'],
      vault: '0xAAA',
    });
    await store.resolve('b', () => Promise.resolve(2), {
      topics: ['transactions'],
      vault: '0xBBB',
    });
    expect(feed.push('0xaaa', event())).toEqual(['a']);
    expect(store.get('b')).toBe(2);
  });

  it('stales an unscoped cross-vault view on a change to any vault', async () => {
    // `inbox` covers every vault at once, so it cannot be scoped to one — a
    // change anywhere makes it wrong.
    const store = new ResultStore(clock().now);
    const feed = new ChangeFeed(store);
    await store.resolve('inbox', () => Promise.resolve(1), { topics: ['transactions'] });
    expect(feed.push('0xanything', event())).toEqual(['inbox']);
  });

  it('routes on topic alone and never reads the row', () => {
    // §8 R10: WatchEvent.row is the entire raw Postgres row and is
    // attacker-influenceable. Keeping it out of the control flow is what makes
    // the injection surface a rendering problem rather than a routing one.
    const store = new ResultStore(clock().now);
    const feed = new ChangeFeed(store);
    const hostile = event({
      row: {
        get name(): string {
          throw new Error('the feed read a row field');
        },
      },
    });
    expect(() => feed.push('0xaaa', hostile)).not.toThrow();
  });

  it('reports the event to subscribers alongside the keys', async () => {
    const store = new ResultStore(clock().now);
    const feed = new ChangeFeed(store);
    await store.resolve('a', () => Promise.resolve(1), { topics: ['recoveries'] });
    const seen: string[] = [];
    feed.subscribe((keys) => seen.push(...keys));
    feed.push('0xaaa', event({ topic: 'recoveries' }));
    expect(seen).toEqual(['a']);
  });
});

describe('cacheKey', () => {
  it('folds address case so one vault is one entry', () => {
    expect(cacheKey(['tx', 'ls'], '0xABCD')).toBe(cacheKey(['tx', 'ls'], '0xabcd'));
  });

  it('keeps "no argument" distinct from an empty one', () => {
    expect(cacheKey(['tx', 'ls'], undefined)).not.toBe(cacheKey(['tx', 'ls'], ''));
  });

  it('separates commands that share their arguments', () => {
    expect(cacheKey(['tx', 'ls'], '0xa')).not.toBe(cacheKey(['tx', 'history'], '0xa'));
  });

  it('separates different arguments to the same command', () => {
    expect(cacheKey(['tx', 'ls'], '0xa', 50)).not.toBe(cacheKey(['tx', 'ls'], '0xa', 100));
  });
});
