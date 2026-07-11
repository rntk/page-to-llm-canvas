import { describe, it, expect } from 'vitest';
import { LLM_TASK_TYPES, emptyLlmMetrics, emptyLlmMetricTotals } from './llmMetrics.js';
import {
  averageDurationMs,
  cacheHitRate,
  formatDurationMs,
  formatMetricCount,
  formatMetricPercent,
  formatTaskTypeLabel,
  listTaskTypes,
} from './llmMetricsFormat.js';

describe('llmMetricsFormat helpers', () => {
  it('formats task type labels', () => {
    expect(formatTaskTypeLabel(LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE)).toBe('Summary merge');
    expect(formatTaskTypeLabel('custom_task')).toBe('Custom Task');
  });

  it('lists task types by count descending', () => {
    const metrics = {
      ...emptyLlmMetrics(),
      byTaskType: {
        article_summary: { ...emptyLlmMetricTotals(), totalCount: 1 },
        topic_ranges: { ...emptyLlmMetricTotals(), totalCount: 5 },
      },
    };
    expect(listTaskTypes(metrics)).toEqual(['topic_ranges', 'article_summary']);
  });

  it('computes average duration and formats durations', () => {
    expect(averageDurationMs(emptyLlmMetrics())).toBeNull();
    expect(averageDurationMs({ ...emptyLlmMetrics(), totalCount: 2, totalDurationMs: 500 })).toBe(
      250,
    );
    expect(
      averageDurationMs({ ...emptyLlmMetricTotals(), totalCount: 4, totalDurationMs: 400 }),
    ).toBe(100);
    expect(formatDurationMs(null)).toBe('—');
    expect(formatDurationMs(420)).toBe('420 ms');
    expect(formatDurationMs(1500)).toBe('1.50 s');
    expect(formatDurationMs(12500)).toBe('12.5 s');
    expect(formatDurationMs(125000)).toBe('2m 5s');
  });

  it('computes cache hit rate and formats counts/percents', () => {
    expect(
      cacheHitRate({
        totalCacheReadTokens: 900,
        totalCacheWriteTokens: 100,
        totalCacheMissTokens: 200,
      }),
    ).toBe(0.75);
    expect(cacheHitRate(emptyLlmMetrics())).toBeNull();
    expect(formatMetricCount(12345.4)).toBe('12,345');
    expect(formatMetricCount(null)).toBe('—');
    expect(formatMetricPercent(0.7534)).toBe('75.3%');
  });
});
