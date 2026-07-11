// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  LLM_METRICS_KEY,
  LLM_METRICS_EPOCH_KEY,
  LLM_METRICS_MAX_RECENT,
  LLM_TASK_TYPES,
  emptyLlmMetrics,
  normalizeLlmMetrics,
  normalizeLlmUsage,
  normalizeTaskType,
  wrapCallLLMWithRetry,
  recordLlmMetric,
  getLlmMetrics,
  clearLlmMetrics,
} from './llmMetrics.js';
import { listTaskTypes } from './llmMetricsFormat.js';

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

  it('normalizes counts, durations, task types, and recent entries', () => {
    const normalized = normalizeLlmMetrics({
      epoch: 7,
      totalCount: 3,
      successCount: 2,
      failureCount: 1,
      totalDurationMs: 1500,
      minDurationMs: 100,
      maxDurationMs: 900,
      recent: [
        { at: 10, durationMs: 100, ok: true, taskType: LLM_TASK_TYPES.TOPIC_RANGES },
        { at: 20, durationMs: 900, ok: false, error: 'boom', taskType: 'article_summary' },
        { at: 30, durationMs: -5, ok: true },
        null,
        'skip',
      ],
      byTaskType: {
        topic_ranges: {
          totalCount: 2,
          successCount: 2,
          failureCount: 0,
          totalDurationMs: 600,
          minDurationMs: 100,
          maxDurationMs: 500,
        },
        article_summary: {
          totalCount: 1,
          successCount: 0,
          failureCount: 1,
          totalDurationMs: 900,
          minDurationMs: 900,
          maxDurationMs: 900,
        },
      },
    });
    expect(normalized.epoch).toBe(7);
    expect(normalized.totalCount).toBe(3);
    expect(normalized.successCount).toBe(2);
    expect(normalized.failureCount).toBe(1);
    expect(normalized.totalDurationMs).toBe(1500);
    expect(normalized.minDurationMs).toBe(100);
    expect(normalized.maxDurationMs).toBe(900);
    expect(normalized.recent).toHaveLength(3);
    expect(normalized.recent[0].taskType).toBe(LLM_TASK_TYPES.TOPIC_RANGES);
    expect(normalized.recent[1]).toEqual({
      at: 20,
      durationMs: 900,
      ok: false,
      error: 'boom',
      taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
    });
    expect(normalized.recent[2].durationMs).toBe(0);
    expect(normalized.recent[2].taskType).toBe(LLM_TASK_TYPES.UNKNOWN);
    expect(normalized.byTaskType.topic_ranges.totalCount).toBe(2);
    expect(normalized.byTaskType.article_summary.failureCount).toBe(1);
  });

  it('defaults missing byTaskType and taskType on legacy payloads', () => {
    const normalized = normalizeLlmMetrics({
      totalCount: 1,
      successCount: 1,
      failureCount: 0,
      totalDurationMs: 10,
      minDurationMs: 10,
      maxDurationMs: 10,
      recent: [{ at: 1, durationMs: 10, ok: true }],
    });
    expect(normalized.byTaskType).toEqual({});
    expect(normalized.recent[0].taskType).toBe(LLM_TASK_TYPES.UNKNOWN);
  });

  it('normalizes task types', () => {
    expect(normalizeTaskType(undefined)).toBe(LLM_TASK_TYPES.UNKNOWN);
    expect(normalizeTaskType('')).toBe(LLM_TASK_TYPES.UNKNOWN);
    expect(normalizeTaskType(LLM_TASK_TYPES.TOPIC_RANGES)).toBe(LLM_TASK_TYPES.TOPIC_RANGES);
    expect(normalizeTaskType('  Custom Task!  ')).toBe('custom_task');
  });

  it('normalizes token and cache usage', () => {
    expect(
      normalizeLlmUsage({
        inputTokens: '1200',
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: -5,
        ignored: 99,
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
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
    await expect(wrapped({ prompt: 'x', taskType: LLM_TASK_TYPES.TOPIC_RANGES }, 2)).resolves.toBe(
      'hello',
    );
    expect(raw).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'x',
        taskType: LLM_TASK_TYPES.TOPIC_RANGES,
        metricsCollector: expect.any(Function),
      }),
      2,
    );

    await vi.waitFor(async () => {
      const metrics = await getLlmMetrics();
      expect(metrics.totalCount).toBe(1);
    });
    const metrics = await getLlmMetrics();
    expect(metrics.successCount).toBe(1);
    expect(metrics.failureCount).toBe(0);
    expect(metrics.recent[0].ok).toBe(true);
    expect(metrics.recent[0].durationMs).toBe(250);
    expect(metrics.recent[0].taskType).toBe(LLM_TASK_TYPES.TOPIC_RANGES);
    expect(metrics.byTaskType.topic_ranges.totalCount).toBe(1);
    expect(metrics.byTaskType.topic_ranges.totalDurationMs).toBe(250);
  });

  it('records failure duration and rethrows', async () => {
    stubChromeStore();

    const raw = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 80);
      throw new Error('rate limited');
    });
    const wrapped = wrapCallLLMWithRetry(raw);
    await expect(
      wrapped({ prompt: 'x', taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY }),
    ).rejects.toThrow('rate limited');

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
      taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
    });
    expect(metrics.byTaskType.article_summary.failureCount).toBe(1);
  });

  it('defaults missing taskType to unknown', async () => {
    stubChromeStore();
    const wrapped = wrapCallLLMWithRetry(async () => 'ok');
    await wrapped({ prompt: 'x' });
    await vi.waitFor(async () => {
      const metrics = await getLlmMetrics();
      expect(metrics.totalCount).toBe(1);
    });
    const metrics = await getLlmMetrics();
    expect(metrics.recent[0].taskType).toBe(LLM_TASK_TYPES.UNKNOWN);
    expect(metrics.byTaskType.unknown.totalCount).toBe(1);
  });

  it('records collected provider usage and response sizes', async () => {
    stubChromeStore();
    const wrapped = wrapCallLLMWithRetry(async (opts) => {
      opts.metricsCollector({
        provider: 'openai',
        model: 'gpt-5-mini',
        requestChars: 4000,
        responseChars: 200,
        usage: {
          inputTokens: 1000,
          outputTokens: 50,
          totalTokens: 1050,
          reasoningTokens: 20,
          cacheReadTokens: 750,
          cacheMissTokens: 250,
        },
      });
      return 'ok';
    });

    await wrapped({ prompt: 'x', taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY });
    await vi.waitFor(async () => {
      const metrics = await getLlmMetrics();
      expect(metrics.usageSampleCount).toBe(1);
    });
    const metrics = await getLlmMetrics();
    expect(metrics).toMatchObject({
      cacheSampleCount: 1,
      totalInputTokens: 1000,
      totalOutputTokens: 50,
      totalTokens: 1050,
      totalReasoningTokens: 20,
      totalCacheReadTokens: 750,
      totalCacheMissTokens: 250,
      totalRequestChars: 4000,
      totalResponseChars: 200,
    });
    expect(metrics.byTaskType.article_summary).toMatchObject({
      usageSampleCount: 1,
      cacheSampleCount: 1,
      totalInputTokens: 1000,
      totalOutputTokens: 50,
      totalCacheReadTokens: 750,
    });
    expect(metrics.recent[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-5-mini',
      requestChars: 4000,
      responseChars: 200,
      usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 750 },
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
        recent: [{ at: 1, durationMs: 10, ok: true, taskType: LLM_TASK_TYPES.TOPIC_RANGES }],
        byTaskType: {
          topic_ranges: {
            totalCount: 1,
            successCount: 1,
            failureCount: 0,
            totalDurationMs: 10,
            minDurationMs: 10,
            maxDurationMs: 10,
          },
        },
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
      recent: [{ at: 1, durationMs: 100, ok: true, taskType: LLM_TASK_TYPES.TOPIC_RANGES }],
      byTaskType: {
        topic_ranges: {
          totalCount: 5,
          successCount: 5,
          failureCount: 0,
          totalDurationMs: 500,
          minDurationMs: 100,
          maxDurationMs: 100,
        },
      },
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

    const recordPromise = recordLlmMetric({
      durationMs: 42,
      ok: true,
      taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
    });
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
    expect(metrics.byTaskType).toEqual({});
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
        recent: [{ at: 1, durationMs: 100, ok: true, taskType: LLM_TASK_TYPES.TOPIC_RANGES }],
        byTaskType: {
          topic_ranges: {
            totalCount: 9,
            successCount: 9,
            failureCount: 0,
            totalDurationMs: 900,
            minDurationMs: 100,
            maxDurationMs: 100,
          },
        },
      },
    });
    await expect(getLlmMetrics()).resolves.toEqual(emptyLlmMetrics(100));
  });

  it('caps recent entries at max', async () => {
    stubChromeStore();

    for (let i = 0; i < LLM_METRICS_MAX_RECENT + 5; i++) {
      await recordLlmMetric({ durationMs: i, ok: true, taskType: LLM_TASK_TYPES.TOPIC_RANGES });
    }
    const metrics = await getLlmMetrics();
    expect(metrics.totalCount).toBe(LLM_METRICS_MAX_RECENT + 5);
    expect(metrics.recent).toHaveLength(LLM_METRICS_MAX_RECENT);
    // Newest first.
    expect(metrics.recent[0].durationMs).toBe(LLM_METRICS_MAX_RECENT + 4);
    expect(metrics.byTaskType.topic_ranges.totalCount).toBe(LLM_METRICS_MAX_RECENT + 5);
  });

  it('separates aggregates by task type', async () => {
    stubChromeStore();

    await recordLlmMetric({
      durationMs: 100,
      ok: true,
      taskType: LLM_TASK_TYPES.TOPIC_RANGES,
    });
    await recordLlmMetric({
      durationMs: 200,
      ok: true,
      taskType: LLM_TASK_TYPES.TOPIC_RANGES,
    });
    await recordLlmMetric({
      durationMs: 400,
      ok: false,
      error: 'nope',
      taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY,
    });
    await recordLlmMetric({
      durationMs: 50,
      ok: true,
      taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE,
    });

    const metrics = await getLlmMetrics();
    expect(metrics.totalCount).toBe(4);
    expect(metrics.successCount).toBe(3);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.totalDurationMs).toBe(750);

    expect(metrics.byTaskType.topic_ranges).toMatchObject({
      totalCount: 2,
      successCount: 2,
      failureCount: 0,
      totalDurationMs: 300,
      minDurationMs: 100,
      maxDurationMs: 200,
    });
    expect(metrics.byTaskType.article_summary).toMatchObject({
      totalCount: 1,
      successCount: 0,
      failureCount: 1,
      totalDurationMs: 400,
    });
    expect(metrics.byTaskType.article_summary_merge.totalCount).toBe(1);
    expect(listTaskTypes(metrics)).toEqual([
      LLM_TASK_TYPES.TOPIC_RANGES,
      LLM_TASK_TYPES.ARTICLE_SUMMARY,
      LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE,
    ]);
    expect(metrics.recent.map((e) => e.taskType)).toEqual([
      LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE,
      LLM_TASK_TYPES.ARTICLE_SUMMARY,
      LLM_TASK_TYPES.TOPIC_RANGES,
      LLM_TASK_TYPES.TOPIC_RANGES,
    ]);
  });
});
