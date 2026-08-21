import { describe, expect, it, vi } from 'vitest';
import { runProviderBurst } from './providerBurst.js';

describe('runProviderBurst', () => {
  it('runs every item when failures are retryable', async () => {
    const retryable = Object.assign(new Error('rate limited'), { status: 429 });

    const burst = await runProviderBurst(['a', 'b', 'c'], 2, async ({ item }) => {
      return { value: item.toUpperCase(), ...(item === 'a' ? { error: retryable } : {}) };
    });

    expect(burst).toEqual({
      results: [{ value: 'A', error: retryable }, { value: 'B' }, { value: 'C' }],
      permanentError: null,
      unclaimed: [],
    });
  });

  it('tracks claims by item when an injectable executor omits callback indexes', async () => {
    const permanent = Object.assign(new Error('unauthorized'), { status: 401 });
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const worker = vi.fn(async ({ item, index }) => {
      expect(index).toBeUndefined();
      return { item, error: permanent };
    });
    const noIndexParallelMap = async (input, _limit, fn, { stopBurst }) => {
      const results = new Array(input.length);
      for (const item of input) {
        results[0] = await fn(item);
        if (stopBurst(results[0], item)) break;
      }
      return results;
    };

    const burst = await runProviderBurst(items, 2, worker, {
      parallelMap: noIndexParallelMap,
    });

    expect(worker).toHaveBeenCalledTimes(1);
    expect(burst.results).toEqual([{ item: items[0], error: permanent }, undefined, undefined]);
    expect(burst.permanentError).toBe(permanent);
    expect(burst.unclaimed).toEqual(items.slice(1));
  });

  it('lets already claimed siblings settle but does not claim more work', async () => {
    const permanent = Object.assign(new Error('unknown model'), { retryable: false });
    const claimed = [];
    let markSiblingStarted;
    let markPermanentObserved;
    const siblingStarted = new Promise((resolve) => {
      markSiblingStarted = resolve;
    });
    const permanentObserved = new Promise((resolve) => {
      markPermanentObserved = resolve;
    });

    const burst = await runProviderBurst(
      [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }],
      2,
      async ({ item }) => {
        claimed.push(item.id);
        if (item.id === 1) {
          await siblingStarted;
          markPermanentObserved();
        }
        if (item.id === 2) {
          markSiblingStarted();
          await permanentObserved;
        }
        return {
          value: item.id,
          ...(item.id === 1 ? { error: permanent } : {}),
        };
      },
    );

    expect(new Set(claimed)).toEqual(new Set([0, 1, 2]));
    expect(burst.results).toEqual([
      { value: 0 },
      { value: 1, error: permanent },
      { value: 2 },
      undefined,
    ]);
    expect(burst.unclaimed).toEqual([{ id: 3 }]);
  });
});
