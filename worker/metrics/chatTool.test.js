import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_TOOL_METRICS_KEY,
  clearChatToolMetrics,
  emptyChatToolMetrics,
  getChatToolMetrics,
  isErrorOutcome,
  normalizeChatToolMetrics,
  recordChatToolMetric,
} from './chatTool.js';

describe('chat tool metrics', () => {
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

  it('counts ok and error outcomes and keeps a recent list', async () => {
    await recordChatToolMetric({ outcome: 'highlighted' });
    await recordChatToolMetric({ outcome: 'overlap_skipped' });
    await recordChatToolMetric({
      outcome: 'out_of_range',
      error: 'line range must be between 1 and 4',
    });
    await recordChatToolMetric({ outcome: 'unknown_tool', error: 'Unknown tool: frobnicate' });
    await recordChatToolMetric({ outcome: 'paint_failed', error: 'canvas gone' });

    const metrics = await getChatToolMetrics();
    expect(metrics).toMatchObject({
      totalCount: 5,
      // highlighted + overlap_skipped + paint_failed are not model errors.
      okCount: 3,
      errorCount: 2,
      byOutcome: {
        highlighted: 1,
        overlap_skipped: 1,
        out_of_range: 1,
        unknown_tool: 1,
        paint_failed: 1,
        invalid_arguments: 0,
        out_of_chunk: 0,
      },
    });
    expect(metrics.recent[0]).toMatchObject({ outcome: 'paint_failed', error: 'canvas gone' });
    expect(metrics.recent).toHaveLength(5);
  });

  it('drops unrecognized outcomes rather than corrupting the store', async () => {
    await recordChatToolMetric({ outcome: 'not_a_real_outcome' });
    await recordChatToolMetric({});
    const metrics = await getChatToolMetrics();
    expect(metrics.totalCount).toBe(0);
    expect(metrics.recent).toEqual([]);
  });

  it('classifies error vs non-error outcomes', () => {
    expect(isErrorOutcome('unknown_tool')).toBe(true);
    expect(isErrorOutcome('invalid_arguments')).toBe(true);
    expect(isErrorOutcome('out_of_range')).toBe(true);
    expect(isErrorOutcome('out_of_chunk')).toBe(true);
    expect(isErrorOutcome('highlighted')).toBe(false);
    expect(isErrorOutcome('overlap_skipped')).toBe(false);
    expect(isErrorOutcome('paint_failed')).toBe(false);
  });

  it('normalizes corrupt payloads and clears stored data', async () => {
    expect(normalizeChatToolMetrics(null)).toEqual(emptyChatToolMetrics());
    stored[CHAT_TOOL_METRICS_KEY] = {
      totalCount: -3,
      recent: 'bad',
      byOutcome: { highlighted: -9 },
    };
    const normalized = normalizeChatToolMetrics(stored[CHAT_TOOL_METRICS_KEY]);
    expect(normalized.totalCount).toBe(0);
    expect(normalized.byOutcome.highlighted).toBe(0);
    expect(normalized.recent).toEqual([]);

    await clearChatToolMetrics();
    expect(stored[CHAT_TOOL_METRICS_KEY]).toEqual(emptyChatToolMetrics());
  });
});
