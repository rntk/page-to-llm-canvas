import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESPLIT_METRICS_KEY,
  RESPLIT_METRICS_MAX_RECENT,
  RESPLIT_OUTCOMES,
  SPAN_BUCKET_KEYS,
  clearResplitMetrics,
  createResplitRunStats,
  emptyResplitMetrics,
  getResplitMetrics,
  noteResplitOutcome,
  normalizeResplitMetrics,
  recordResplitRun,
  spanBucketKey,
} from './resplit.js';

describe('resplit metrics', () => {
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

  it('records a run with no oversized ranges without incrementing runsWithOversize', async () => {
    await recordResplitRun({
      segmentCount: 5,
      oversizeCount: 0,
      oversizeSpans: [],
      maxSpan: 12,
      resplitCallCount: 0,
      changed: false,
      groupCountBefore: 5,
      groupCountAfter: 5,
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runCount).toBe(1);
    expect(metrics.runsWithOversize).toBe(0);
    expect(metrics.runsChanged).toBe(0);
    expect(metrics.oversizeSegmentCount).toBe(0);
    expect(metrics.resplitCallCount).toBe(0);
  });

  it('records a run with oversized ranges across the outcome/bucket/span tallies', async () => {
    await recordResplitRun({
      segmentCount: 5,
      oversizeCount: 4,
      oversizeSpans: [41, 100, 240, 241],
      resplitCallCount: 4,
      changed: true,
      groupCountBefore: 5,
      groupCountAfter: 8,
      outcomes: {
        [RESPLIT_OUTCOMES.SUBDIVIDED]: 2,
        [RESPLIT_OUTCOMES.ACCEPTED_SINGLE]: 1,
        [RESPLIT_OUTCOMES.WINDOW_FALLBACK]: 1,
      },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runCount).toBe(1);
    expect(metrics.runsWithOversize).toBe(1);
    expect(metrics.runsChanged).toBe(1);
    expect(metrics.oversizeSegmentCount).toBe(4);
    expect(metrics.resplitCallCount).toBe(4);
    expect(metrics.maxSpanObserved).toBe(241);
    expect(metrics.outcomes).toMatchObject({
      subdivided: 2,
      acceptedSingle: 1,
      windowFallback: 1,
      noProgress: 0,
      error: 0,
    });
    expect(metrics.oversizeSpanBuckets).toMatchObject({
      le60: 1,
      le120: 1,
      le240: 1,
      gt240: 1,
      le80: 0,
    });
  });

  it('checks spanBucketKey boundaries', () => {
    // Only spans above the 40-sentence oversize threshold are ever bucketed,
    // so the lowest bucket absorbs everything at or below 60.
    expect(spanBucketKey(41)).toBe('le60');
    expect(spanBucketKey(60)).toBe('le60');
    expect(spanBucketKey(61)).toBe('le80');
    expect(spanBucketKey(240)).toBe('le240');
    expect(spanBucketKey(241)).toBe('gt240');
  });

  it('accumulates outcome tallies across multiple runs', async () => {
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
    });
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.ACCEPTED_SINGLE]: 1 },
    });
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.WINDOW_FALLBACK]: 1 },
    });
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.NO_PROGRESS]: 1 },
    });
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.ERROR]: 1 },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runCount).toBe(5);
    expect(metrics.outcomes).toEqual({
      subdivided: 1,
      acceptedSingle: 1,
      windowFallback: 1,
      noProgress: 1,
      error: 1,
    });
  });

  it('stores groupCountBefore/After for a changed run and increments runsChanged', async () => {
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [50],
      resplitCallCount: 1,
      changed: true,
      groupCountBefore: 3,
      groupCountAfter: 5,
      outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runsChanged).toBe(1);
    expect(metrics.runsWithGroupGain).toBe(1);
    expect(metrics.recent[0]).toMatchObject({
      changed: true,
      groupCountBefore: 3,
      groupCountAfter: 5,
    });
  });

  it('increments runsChanged but not runsWithGroupGain when groupCountAfter equals groupCountBefore', async () => {
    // Mirrors the window-fallback case: the resplit subdivided the segment
    // (changed: true) but groupsFromSegments recombined it back into the
    // same number of groups, so no net gain was produced.
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 3,
      changed: true,
      groupCountBefore: 1,
      groupCountAfter: 1,
      outcomes: { [RESPLIT_OUTCOMES.WINDOW_FALLBACK]: 1 },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runsChanged).toBe(1);
    expect(metrics.runsWithGroupGain).toBe(0);
  });

  it('increments both runsChanged and runsWithGroupGain when groupCountAfter exceeds groupCountBefore', async () => {
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 1,
      changed: true,
      groupCountBefore: 1,
      groupCountAfter: 2,
      outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.runsChanged).toBe(1);
    expect(metrics.runsWithGroupGain).toBe(1);
  });

  it('aggregates llmRequestCount independently of resplitCallCount across runs', async () => {
    // A single invocation whose tagged text exceeded MAX_TAGGED_CHARS fanned
    // out into 5 chunk requests: resplitCallCount (invocations) stays at 2,
    // llmRequestCount (actual LLM requests) is 5.
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 2,
      llmRequestCount: 5,
      outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
    });
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 1,
      llmRequestCount: 1,
      outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
    });

    const metrics = await getResplitMetrics();
    expect(metrics.resplitCallCount).toBe(3);
    expect(metrics.llmRequestCount).toBe(6);
  });

  it('yields llmRequestCount 0 when a run passes neither resplitCallCount nor llmRequestCount', async () => {
    await recordResplitRun({ oversizeCount: 0, oversizeSpans: [] });

    const metrics = await getResplitMetrics();
    expect(metrics.resplitCallCount).toBe(0);
    expect(metrics.llmRequestCount).toBe(0);
  });

  it('falls back llmRequestCount to resplitCallCount for a top-level legacy object missing it', () => {
    const legacy = {
      runCount: 10,
      resplitCallCount: 7,
      // llmRequestCount intentionally absent (predates the counter).
    };
    const normalized = normalizeResplitMetrics(legacy);
    expect(normalized.llmRequestCount).toBe(7);
  });

  it('falls back llmRequestCount to resplitCallCount within a legacy recent[] entry missing it', () => {
    const legacy = {
      recent: [{ resplitCallCount: 4 }],
    };
    const normalized = normalizeResplitMetrics(legacy);
    expect(normalized.recent[0]).toMatchObject({ resplitCallCount: 4, llmRequestCount: 4 });
  });

  it('accumulates primaryChunkCount into primaryRequestCount across runs', async () => {
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 1,
      primaryChunkCount: 3,
    });
    await recordResplitRun({
      oversizeCount: 0,
      oversizeSpans: [],
      primaryChunkCount: 1,
    });

    const metrics = await getResplitMetrics();
    expect(metrics.primaryRequestCount).toBe(4);
  });

  it('yields primaryRequestCount 0 when a run omits primaryChunkCount', async () => {
    await recordResplitRun({ oversizeCount: 0, oversizeSpans: [] });

    const metrics = await getResplitMetrics();
    expect(metrics.primaryRequestCount).toBe(0);
  });

  it('defaults primaryRequestCount to 0 for a legacy top-level object lacking it', () => {
    const legacy = {
      runCount: 10,
      resplitCallCount: 7,
      // primaryRequestCount intentionally absent (predates the counter).
    };
    const normalized = normalizeResplitMetrics(legacy);
    expect(normalized.primaryRequestCount).toBe(0);
  });

  it('carries primaryChunkCount on recent[] entries', async () => {
    await recordResplitRun({
      oversizeCount: 1,
      oversizeSpans: [60],
      resplitCallCount: 1,
      primaryChunkCount: 2,
    });

    const metrics = await getResplitMetrics();
    expect(metrics.recent[0]).toMatchObject({ primaryChunkCount: 2 });
  });

  it('caps recent at RESPLIT_METRICS_MAX_RECENT, newest first, and strips oversizeSpans', async () => {
    const total = RESPLIT_METRICS_MAX_RECENT + 5;
    for (let i = 0; i < total; i++) {
      await recordResplitRun({
        segmentCount: i,
        oversizeCount: 1,
        oversizeSpans: [50 + i],
        resplitCallCount: 1,
      });
    }

    const metrics = await getResplitMetrics();
    expect(metrics.recent).toHaveLength(RESPLIT_METRICS_MAX_RECENT);
    expect(metrics.recent[0].segmentCount).toBe(total - 1);
    expect(metrics.recent.at(-1).segmentCount).toBe(total - RESPLIT_METRICS_MAX_RECENT);
    for (const entry of metrics.recent) {
      expect(entry).not.toHaveProperty('oversizeSpans');
    }
  });

  it('normalizes corrupt/legacy payloads without throwing', () => {
    expect(normalizeResplitMetrics(undefined)).toEqual(emptyResplitMetrics());
    expect(normalizeResplitMetrics(null)).toEqual(emptyResplitMetrics());
    expect(normalizeResplitMetrics('bad')).toEqual(emptyResplitMetrics());
    expect(normalizeResplitMetrics(['bad'])).toEqual(emptyResplitMetrics());
    // Legacy object missing the new fields entirely.
    expect(normalizeResplitMetrics({ totalCount: 3, recent: 'not-an-array' })).toEqual(
      emptyResplitMetrics(),
    );
  });

  it('defaults runsWithGroupGain to 0 for a legacy stored object lacking the field', () => {
    // Simulates a payload written before runsWithGroupGain existed: other
    // real counters are present, but runsWithGroupGain itself is absent.
    const legacy = {
      runCount: 10,
      runsWithOversize: 4,
      runsChanged: 2,
      oversizeSegmentCount: 4,
      resplitCallCount: 4,
      maxSpanObserved: 90,
      outcomes: { subdivided: 2 },
      oversizeSpanBuckets: { le80: 2 },
      recent: [],
    };
    const normalized = normalizeResplitMetrics(legacy);
    expect(normalized.runsWithGroupGain).toBe(0);
    expect(normalized.runCount).toBe(10);
    expect(normalized.runsChanged).toBe(2);
  });

  it('clears stored metrics back to empty', async () => {
    await recordResplitRun({ oversizeCount: 1, oversizeSpans: [50], resplitCallCount: 1 });
    expect((await getResplitMetrics()).runCount).toBe(1);

    await clearResplitMetrics();
    expect(stored[RESPLIT_METRICS_KEY]).toEqual(emptyResplitMetrics());
    expect((await getResplitMetrics()).runCount).toBe(0);
  });

  it('is a no-op when the Chrome storage namespace is unavailable', async () => {
    vi.stubGlobal('chrome', { runtime: {} });

    await expect(
      recordResplitRun({ oversizeCount: 1, oversizeSpans: [50] }),
    ).resolves.toBeUndefined();
    await expect(getResplitMetrics()).resolves.toEqual(emptyResplitMetrics());
  });

  it('serializes concurrent recordResplitRun calls without losing counts', async () => {
    const calls = [];
    for (let i = 0; i < 10; i++) {
      calls.push(
        recordResplitRun({
          oversizeCount: 1,
          oversizeSpans: [50],
          resplitCallCount: 1,
          outcomes: { [RESPLIT_OUTCOMES.SUBDIVIDED]: 1 },
        }),
      );
    }
    await Promise.all(calls);

    const metrics = await getResplitMetrics();
    expect(metrics.runCount).toBe(10);
    expect(metrics.runsWithOversize).toBe(10);
    expect(metrics.oversizeSegmentCount).toBe(10);
    expect(metrics.resplitCallCount).toBe(10);
    expect(metrics.outcomes.subdivided).toBe(10);
    expect(metrics.oversizeSpanBuckets.le60).toBe(10);
  });

  it('exposes the per-run stats helpers used by the pipeline stage', () => {
    const stats = createResplitRunStats();
    expect(stats.outcomes).toEqual({
      subdivided: 0,
      acceptedSingle: 0,
      windowFallback: 0,
      noProgress: 0,
      error: 0,
    });

    noteResplitOutcome(stats, RESPLIT_OUTCOMES.SUBDIVIDED);
    noteResplitOutcome(stats, 'not-a-real-outcome');
    noteResplitOutcome(null, RESPLIT_OUTCOMES.SUBDIVIDED);
    expect(stats.outcomes.subdivided).toBe(1);

    expect(SPAN_BUCKET_KEYS).toEqual(['le60', 'le80', 'le120', 'le240', 'gt240']);
  });
});
