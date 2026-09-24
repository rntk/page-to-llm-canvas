import { describe, expect, it, vi } from 'vitest';
import { refineOversizedRanges } from './topicRangeResplit.js';
import { RESPLIT_OUTCOMES } from '../metrics/resplit.js';
import { getPipelineTextChunkMaxChars, getTopicRangeInputMaxSentences } from './pipelineConfig.js';
import { estimateTokens } from '../llm/tokenEstimator.js';

describe('refineOversizedRanges failure handling', () => {
  it('sizes dispatched chunks for a long CJK parent path', async () => {
    const contextTokens = 4096;
    const groups = [{ label: ['研究'.repeat(180)], ranges: [{ start: 0, end: 40 }] }];
    const sentenceTexts = Array.from({ length: 41 }, () => '漢'.repeat(200));
    const runtime = {
      log: vi.fn(async () => {}),
      maxTextChunkChars: getPipelineTextChunkMaxChars(contextTokens),
      maxTopicRangeSentences: getTopicRangeInputMaxSentences(contextTokens),
      preferContentLanguage: true,
    };
    const callLLM = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const dependencies = {
      parallelMap: async (items, _limit, callback) => Promise.all(items.map(callback)),
      noteResplitOutcome: vi.fn(),
      recordResplitRun: vi.fn(async () => {}),
      createResplitRunStats: () => ({}),
    };

    await refineOversizedRanges(runtime, groups, sentenceTexts, callLLM, { dependencies });

    expect(callLLM).toHaveBeenCalled();
    for (const [request] of callLLM.mock.calls) {
      expect(
        estimateTokens(request.prompt) + runtime.maxTopicRangeSentences * 32,
      ).toBeLessThanOrEqual(contextTokens);
    }
  });

  it('keeps the original range and records an error when the provider rejects', async () => {
    const groups = [{ label: ['Science', 'AI'], ranges: [{ start: 0, end: 40 }] }];
    const sentenceTexts = Array.from({ length: 41 }, (_, index) => `Sentence ${index}`);
    const providerError = new Error('provider unavailable');
    const runtime = { log: vi.fn(async () => {}), signal: undefined };
    const noteResplitOutcome = vi.fn();
    const recordResplitRun = vi.fn(async () => {});
    const parallelMap = async (items, _limit, callback) => Promise.all(items.map(callback));
    const createResplitRunStats = () => ({
      resplitCallCount: 0,
      llmRequestCount: 0,
      primaryChunkCount: 0,
      groupCountBefore: 0,
      groupCountAfter: 0,
    });

    const result = await refineOversizedRanges(
      runtime,
      groups,
      sentenceTexts,
      vi.fn(async () => {
        throw providerError;
      }),
      {
        dependencies: { parallelMap, noteResplitOutcome, recordResplitRun, createResplitRunStats },
      },
    );

    expect(result).toEqual(groups);
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_ranges_resplit_error',
      expect.objectContaining({
        start: 0,
        end: 40,
        error: 'provider unavailable',
      }),
    );
    expect(noteResplitOutcome).toHaveBeenCalledWith(expect.anything(), RESPLIT_OUTCOMES.ERROR);
    expect(recordResplitRun).toHaveBeenCalledTimes(1);
  });
});
