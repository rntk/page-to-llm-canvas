import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMetricsStore } from './metricsStore.js';

const KEY = 'pagetollm-test-metrics';

function empty() {
  return { count: 0 };
}

function normalize(value) {
  if (!value || typeof value !== 'object') return empty();
  return { count: Math.max(0, Number(value.count) || 0) };
}

describe('createMetricsStore', () => {
  let stored;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal('chrome', {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((key, callback) => callback({ [key]: stored[key] })),
          set: vi.fn((items, callback) => {
            Object.assign(stored, items);
            callback?.();
          }),
        },
      },
    });
  });

  it('degrades reads to the empty snapshot on failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failingChrome = {
      runtime: {},
      storage: {
        local: {
          get: vi.fn((_key, _callback) => {
            throw new Error('boom');
          }),
          set: vi.fn((items, callback) => {
            Object.assign(stored, items);
            callback?.();
          }),
        },
      },
    };
    vi.stubGlobal('chrome', failingChrome);

    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });
    await expect(store.getMetrics()).resolves.toEqual(empty());
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('test metrics read failed'),
      expect.any(Error),
    );
  });

  it('returns the empty snapshot without touching storage when chrome is unavailable', async () => {
    vi.stubGlobal('chrome', { runtime: {} });
    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });
    await expect(store.getMetrics()).resolves.toEqual(empty());
  });

  it('clear() rejects to the caller on failure while the chain stays usable', async () => {
    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });

    // First write succeeds so there is something to clear.
    await store.queueWrite((metrics) => {
      metrics.count += 1;
      return metrics;
    });
    expect(stored[KEY]).toEqual({ count: 1 });

    // Make the next chrome.storage.local.set call fail (the one clear() triggers).
    chrome.storage.local.set.mockImplementationOnce((_items, callback) => {
      chrome.runtime.lastError = { message: 'set failed' };
      callback?.();
      chrome.runtime.lastError = undefined;
    });

    await expect(store.clear()).rejects.toThrow('set failed');
    // The stored value is untouched by the failed clear.
    expect(stored[KEY]).toEqual({ count: 1 });

    // A subsequent write must still go through: the internal chain must not
    // be left rejected by the failed clear.
    await store.queueWrite((metrics) => {
      metrics.count += 10;
      return metrics;
    });
    expect(stored[KEY]).toEqual({ count: 11 });
  });

  it('queueWrite logs and resolves on failure while the chain stays usable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });

    chrome.storage.local.set.mockImplementationOnce((_items, callback) => {
      chrome.runtime.lastError = { message: 'set failed' };
      callback?.();
      chrome.runtime.lastError = undefined;
    });

    await expect(
      store.queueWrite((metrics) => {
        metrics.count += 1;
        return metrics;
      }),
    ).resolves.toBeUndefined();
    expect(stored[KEY]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('test metrics record failed'),
      expect.any(Error),
    );

    await store.queueWrite((metrics) => {
      metrics.count += 10;
      return metrics;
    });
    expect(stored[KEY]).toEqual({ count: 10 });
  });

  it('does not overwrite metrics when its read fails transiently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stored[KEY] = { count: 7 };
    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });

    chrome.storage.local.get.mockImplementationOnce(() => {
      throw new Error('get failed');
    });

    await expect(
      store.queueWrite((metrics) => {
        metrics.count += 1;
        return metrics;
      }),
    ).resolves.toBeUndefined();

    expect(stored[KEY]).toEqual({ count: 7 });
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('test metrics record failed'),
      expect.any(Error),
    );
  });

  it('queueWrite skips the storage write when mutate returns a nullish value', async () => {
    const store = createMetricsStore({ key: KEY, normalize, empty, label: 'test' });
    await store.queueWrite(() => null);
    expect(stored[KEY]).toBeUndefined();
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps independent write chains per store instance', async () => {
    const storeA = createMetricsStore({ key: 'key-a', normalize, empty, label: 'a' });
    const storeB = createMetricsStore({ key: 'key-b', normalize, empty, label: 'b' });

    await Promise.all([
      storeA.queueWrite((metrics) => {
        metrics.count += 1;
        return metrics;
      }),
      storeB.queueWrite((metrics) => {
        metrics.count += 2;
        return metrics;
      }),
    ]);

    expect(stored['key-a']).toEqual({ count: 1 });
    expect(stored['key-b']).toEqual({ count: 2 });
  });
});
