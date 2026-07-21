import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PARSER_METRICS_KEY,
  clearParserMetrics,
  emptyParserMetrics,
  getParserMetrics,
  normalizeParserMetrics,
  recordParserMetric,
} from './parser.js';

describe('parser metrics', () => {
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

  it('records clean, repaired, failed, and retry-recovered attempts', async () => {
    await recordParserMetric({ ok: true, diagnostics: { sentenceCount: 4 } });
    await recordParserMetric({
      ok: false,
      attempt: 1,
      diagnostics: { sentenceCount: 4, invalidRangeTokens: 2, missing: [0, 1, 2, 3] },
      error: 'No valid topic ranges',
    });
    await recordParserMetric({
      ok: true,
      attempt: 2,
      recoveredAfterRetry: true,
      diagnostics: { sentenceCount: 4, outOfRange: [[0, 9]], reversedRanges: 1 },
    });

    const metrics = await getParserMetrics();
    expect(metrics).toMatchObject({
      totalCount: 3,
      successCount: 2,
      failureCount: 1,
      repairedCount: 1,
      retryRecoveredCount: 1,
      totals: {
        invalidRangeTokens: 2,
        outOfRangeRanges: 1,
        duplicateSentences: 0,
        missingSentences: 4,
        reversedRanges: 1,
        ignoredLines: 0,
      },
    });
    expect(metrics.recent[0]).toMatchObject({ ok: true, attempt: 2, repaired: true });
    expect(JSON.stringify(metrics)).not.toContain('No valid topic ranges found in response body');
  });

  it('normalizes corrupt payloads and clears stored data', async () => {
    expect(normalizeParserMetrics(null)).toEqual(emptyParserMetrics());
    stored[PARSER_METRICS_KEY] = { totalCount: -5, recent: 'bad' };
    await clearParserMetrics();
    expect(stored[PARSER_METRICS_KEY]).toEqual(emptyParserMetrics());
  });

  it('returns empty metrics when the Chrome storage namespace is unavailable', async () => {
    vi.stubGlobal('chrome', { runtime: {} });

    await expect(getParserMetrics()).resolves.toEqual(emptyParserMetrics());
  });
});
