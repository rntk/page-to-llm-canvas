// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  LLM_METRICS_KEY,
  LLM_METRICS_EPOCH_KEY,
  LLM_METRICS_MAX_RECENT,
  emptyLlmMetrics,
  normalizeLlmMetrics,
  averageDurationMs,
  formatDurationMs,
  wrapCallLLMWithRetry,
  recordLlmMetric,
  getLlmMetrics,
  clearLlmMetrics,
} from './llmMetrics.js';

function stubChromeStore(initial = {}) {
  const store = { ...initial };
  vi.stubGlobal('chrome', {
    runtime: {},
    storage: {
      local: {
        get: vi.fn((key, cb) => {
          if (Array.isArray(key)) {
            const items = {};
            for (const k of key) items[k] = store[k];
            cb(items);
            return;
          }
          cb({ [key]: store[key] });
        }),
        set: vi.fn((items, cb) => {
          Object.assign(store, items);
          cb();
        }),
        remove: vi.fn((key, cb) => {
          const keys = Array.isArray(key) ? key : [key];
          for (const k of keys) delete store[k];
          cb();
        }),
      },
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('normalizeLlmMetrics / helpers', () => {
  it('returns empty metrics for invalid values', () => {
    expect(normalizeLlmMetrics(undefined)).toEqual(emptyLlmMetrics());
    expect(normalizeLlmMetrics(null)).toEqual(emptyLlmMetrics());
    expect(normalizeLlmMetrics('nope')).toEqual(emptyLlmMetrics());
  });

  it('normalizes counts, durations, and recent entries', () => {
    const normalized = normalizeLlmMetrics({
      epoch: 7,
      totalCount: 3,
      successCount: 2,
      failureCount: 1,
      totalDurationMs: 1500,
      minDurationMs: 100,
      maxDurationMs: 900,
      recent: [
        { at: 10, durationMs: 100, ok: true },
        { at: 20, durationMs: 900, ok: false, error: 'boom' },
        { at: 30, durationMs: -5, ok: true },
        null,
        'skip',
      ],
    });
    expect(normalized.epoch).toBe(7);
    expect(normalized.totalCount).toBe(3);
    expect(normalized.successCount).toBe(2);
    expect(normalized.failureCount).toBe(1);
    expect(normalized.totalDurationMs).toBe(1500);
    expect(normalized.minDurationMs).toBe(100);
    expect(normalized.maxDurationMs).toBe(900);
    expect(normalized.recent).toHaveLength(3);
    expect(normalized.recent[1]).toEqual({
      at: 20,
      durationMs: 900,
      ok: false,
      error: 'boom',
    });
    expect(normalized.recent[2].durationMs).toBe(0);
  });

  it('computes average duration and formats durations', () => {
    expect(averageDurationMs(emptyLlmMetrics())).toBeNull();
    expect(averageDurationMs({ ...emptyLlmMetrics(), totalCount: 2, totalDurationMs: 500 })).toBe(
      250,
    );
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(420)).toBe('420 ms');
    expect(formatDurationMs(1500)).toBe('1.50 s');
    expect(formatDurationMs(12500)).toBe('12.5 s');
    expect(formatDurationMs(125000)).toBe('2m 5s');
  });
});

describe('wrapCallLLMWithRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('records success duration and returns the result', async () => {
    stubChromeStore();

    const raw = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 250);
      return 'hello';
    });
    const wrapped = wrapCallLLMWithRetry(raw);
    await expect(wrapped({ prompt: 'x' }, 2)).resolves.toBe('hello');
    expect(raw).toHaveBeenCalledWith({ prompt: 'x' }, 2);

    await vi.waitFor(async () => {
      const metrics = await getLlmMetrics();
      expect(metrics.totalCount).toBe(1);
    });
    const metrics = await getLlmMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.recent[0].ok).toBe(true);
    expect(metrics.recent[0].durationMs).toBe(250);
  });

  it('records failure duration and rethrows', async () => {
    stubChromeStore();

    const raw = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 80);
      throw new Error('rate limited');
    });
    const wrapped = wrapCallLLMWithRetry(raw);
    await expect(wrapped({ prompt: 'x' })).rejects.toThrow('rate limited');

    await vi.waitFor(async () => {
      const metrics = await getLlmMetrics();
      expect(metrics.totalCount).toBe(1);
    });
    const metrics = await getLlmMetrics();
    expect(metrics.failureCount).toBe(1);
    expect(metrics.recent[0]).toMatchObject({
      ok: false,
      durationMs: 80,
      error: 'rate limited',
    });
  });
});

describe('storage accessors', () => {
  it('degrades gracefully without chrome', async () => {
    await expect(getLlmMetrics()).resolves.toEqual(emptyLlmMetrics());
    await expect(recordLlmMetric({ durationMs: 10, ok: true })).resolves.toBeUndefined();
    await expect(clearLlmMetrics()).resolves.toBeUndefined();
  });

  it('clears stored metrics and bumps epoch', async () => {
    const store = stubChromeStore({
      [LLM_METRICS_KEY]: {
        epoch: 0,
        totalCount: 1,
        successCount: 1,
        failureCount: 0,
        totalDurationMs: 10,
        minDurationMs: 10,
        maxDurationMs: 10,
        recent: [{ at: 1, durationMs: 10, ok: true }],
      },
    });

    await clearLlmMetrics();
    expect(store[LLM_METRICS_KEY]).toEqual(emptyLlmMetrics(store[LLM_METRICS_EPOCH_KEY]));
    expect(store[LLM_METRICS_EPOCH_KEY]).toEqual(expect.any(Number));
    await expect(getLlmMetrics()).resolves.toEqual(emptyLlmMetrics(store[LLM_METRICS_EPOCH_KEY]));
  });

  it('does not let an in-flight pre-clear record rewrite cleared metrics', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const preClearMetrics = {
      epoch: 0,
      totalCount: 5,
      successCount: 5,
      failureCount: 0,
      totalDurationMs: 500,
      minDurationMs: 100,
      maxDurationMs: 100,
      recent: [{ at: 1, durationMs: 100, ok: true }],
    };
    const store = stubChromeStore({
      [LLM_METRICS_KEY]: preClearMetrics,
      [LLM_METRICS_EPOCH_KEY]: 0,
    });

    let releaseGet;
    const gate = new Promise((resolve) => {
      releaseGet = resolve;
    });
    let metricsReads = 0;

    // Return a stale pre-clear snapshot for the first metrics read so a
    // cross-context clear can land between read and write.
    chrome.storage.local.get = vi.fn((key, cb) => {
      const respond = (value) => {
        if (Array.isArray(key)) {
          const items = {};
          for (const k of key) {
            items[k] = k === LLM_METRICS_KEY && value !== undefined ? value : store[k];
          }
          cb(items);
          return;
        }
        if (key === LLM_METRICS_KEY && value !== undefined) {
          cb({ [key]: value });
          return;
        }
        cb({ [key]: store[key] });
      };

      if (key === LLM_METRICS_KEY) {
        metricsReads += 1;
        if (metricsReads === 1) {
          const stale = preClearMetrics;
          void gate.then(() => respond(stale));
          return;
        }
      }
      respond();
    });

    const recordPromise = recordLlmMetric({ durationMs: 42, ok: true });
    // Allow the record job to start and hit the gated get.
    await Promise.resolve();
    await Promise.resolve();

    // Simulate options-page clear in a different JS realm (not this writeChain).
    vi.setSystemTime(Date.now() + 1000);
    const clearEpoch = Date.now();
    store[LLM_METRICS_EPOCH_KEY] = clearEpoch;
    store[LLM_METRICS_KEY] = emptyLlmMetrics(clearEpoch);

    releaseGet();
    await recordPromise;

    const metrics = await getLlmMetrics();
    expect(metrics.totalCount).toBe(0);
    expect(metrics.recent).toEqual([]);
    expect(store[LLM_METRICS_EPOCH_KEY]).toBe(clearEpoch);
  });

  it('treats metrics with mismatched epoch as empty', async () => {
    stubChromeStore({
      [LLM_METRICS_EPOCH_KEY]: 100,
      [LLM_METRICS_KEY]: {
        epoch: 0,
        totalCount: 9,
        successCount: 9,
        failureCount: 0,
        totalDurationMs: 900,
        minDurationMs: 100,
        maxDurationMs: 100,
        recent: [{ at: 1, durationMs: 100, ok: true }],
      },
    });
    await expect(getLlmMetrics()).resolves.toEqual(emptyLlmMetrics(100));
  });

  it('caps recent entries at max', async () => {
    stubChromeStore();

    for (let i = 0; i < LLM_METRICS_MAX_RECENT + 5; i++) {
      await recordLlmMetric({ durationMs: i, ok: true });
    }
    const metrics = await getLlmMetrics();
    expect(metrics.totalCount).toBe(LLM_METRICS_MAX_RECENT + 5);
    expect(metrics.recent).toHaveLength(LLM_METRICS_MAX_RECENT);
    // Newest first.
    expect(metrics.recent[0].durationMs).toBe(LLM_METRICS_MAX_RECENT + 4);
  });
});
