import { describe, expect, it, vi } from 'vitest';
import { applyTopicResplit } from './topicResplitApply.js';
import { resplitTopicRange } from './topicRangeResplit.js';
import { getPipelineTextChunkMaxChars, getTopicRangeInputMaxSentences } from './pipelineConfig.js';
import { estimateTokens } from '../llm/tokenEstimator.js';

function createDependencies(overrides = {}) {
  return {
    parallelMap: async (items, _limit, callback) => Promise.all(items.map(callback)),
    recordParserMetric: vi.fn(async () => {}),
    ...overrides,
  };
}

function createRuntime(overrides = {}) {
  return {
    log: vi.fn(async () => {}),
    maxTextChunkChars: 10000,
    maxTopicRangeSentences: 100,
    preferContentLanguage: false,
    ...overrides,
  };
}

describe('resplitTopicRange', () => {
  it('returns absolute groups the caller can apply while preserving sentences outside the card', async () => {
    const names = [
      'Async Validation',
      'Deterministic Counts',
      'Benchmark Execution',
      'Guardrails & CI',
      'Instruction Count Validation',
    ];
    const ranges = ['0-5', '6-8', '9-14', '15-23', '24-25'];
    const record = {
      sentences: Array.from({ length: 28 }, (_, i) => String(i)),
      topics: [
        {
          name: 'Technology>Measurement',
          sentences: [1, ...Array.from({ length: 26 }, (_, i) => i + 3)],
        },
        { name: 'Other', sentences: [2] },
      ],
    };
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Technology', 'Measurement'], start: 2, end: 27 },
      record.sentences,
      vi.fn(async () =>
        names
          .map((name, i) => 'Technology>Performance Measurement>' + name + ': ' + ranges[i])
          .join('\n'),
      ),
      { dependencies: createDependencies() },
    );
    expect(groups).toHaveLength(5);
    const applied = applyTopicResplit(
      record,
      { path: 'Technology>Measurement', startSentence: 3, endSentence: 28 },
      groups.map(({ label, ranges: groupRanges }) => ({
        name: label.join('>'),
        sentences: groupRanges.flatMap(({ start, end }) =>
          Array.from({ length: end - start + 1 }, (_, i) => start + i + 1),
        ),
      })),
    );
    expect(applied.topics.slice(0, 2)).toEqual([
      { name: 'Technology>Measurement', sentences: [1] },
      { name: 'Other', sentences: [2] },
    ]);
    expect(applied.topics.slice(2).map(({ name }) => name)).toEqual(
      names.map((name) => 'Technology>Performance Measurement>' + name),
    );
    expect(applied.topics.slice(2).flatMap(({ sentences }) => sentences)).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 3),
    );
  });

  it.each([
    [['Science'], 'Physics', ['Physics']],
    [['A', 'B'], 'A>Replacement', ['A', 'Replacement']],
    [['A', 'B', 'C'], 'A>B>New>Sub', ['A', 'B', 'New', 'Sub']],
    [['A', 'B', 'C', 'D', 'E'], 'A>B>C>D>Replacement', ['A', 'B', 'C', 'D', 'Replacement']],
    [['Alpha', 'Saved Name'], ' alpha > new name ', ['Alpha', 'new name']],
  ])(
    'accepts a full path for %j and preserves saved ancestors',
    async (label, returned, expected) => {
      const groups = await resplitTopicRange(
        createRuntime(),
        { label, start: 1, end: 2 },
        ['outside', 'one', 'two'],
        vi.fn(async () => returned + ': 0-1'),
        { dependencies: createDependencies() },
      );
      expect(groups).toEqual([{ label: expected, ranges: [{ start: 1, end: 2 }] }]);
    },
  );

  it.each([
    [['A', 'B'], 'B>Sub'],
    [['A', 'B', 'C'], 'B>New>Sub'],
    [['A', 'B', 'C'], 'A>B'],
    [['A', 'B', 'C'], 'X>Y>Replacement'],
    [['A', 'B', 'C'], 'A>X>Replacement'],
    [['A', 'B', 'C'], 'A>B>C>D>E>F'],
    [['A', 'B', 'C', 'D', 'E'], 'A>B>C>D>E>Sub'],
  ])('keeps the selected topic for invalid returned path %j + %j', async (label, returned) => {
    const groups = await resplitTopicRange(
      createRuntime(),
      { label, start: 0, end: 1 },
      ['one', 'two'],
      vi.fn(async () => returned + ': 0-1'),
      { dependencies: createDependencies() },
    );
    expect(groups).toEqual([{ label, ranges: [{ start: 0, end: 1 }] }]);
  });

  it('applies valid groups while retaining only the invalid group at the selected topic', async () => {
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science', 'AI'], start: 2, end: 5 },
      ['outside', 'outside', 'one', 'two', 'three', 'four'],
      vi.fn(async () => 'Science>AI>Models: 0-0\nOther>Wrong: 1-2\nScience>AI>Safety: 3-3'),
      { dependencies: createDependencies() },
    );
    expect(groups).toEqual([
      { label: ['Science', 'AI', 'Models'], ranges: [{ start: 2, end: 2 }] },
      { label: ['Science', 'AI'], ranges: [{ start: 3, end: 4 }] },
      { label: ['Science', 'AI', 'Safety'], ranges: [{ start: 5, end: 5 }] },
    ]);
  });

  it('returns an unchanged label', async () => {
    const callLLM = vi.fn(async () => 'Science: 0-1');
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science'], start: 0, end: 1 },
      ['one', 'two'],
      callLLM,
      { dependencies: createDependencies() },
    );
    expect(groups).toEqual([{ label: ['Science'], ranges: [{ start: 0, end: 1 }] }]);
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it('queries a selected range below the automatic size threshold', async () => {
    const callLLM = vi.fn(async () => 'Physics: 0-1\nChemistry: 2-2');
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science'], start: 2, end: 4 },
      ['a', 'b', 'c', 'd', 'e', 'f'],
      callLLM,
      { dependencies: createDependencies() },
    );
    expect(callLLM).toHaveBeenCalledOnce();
    expect(groups).toEqual([
      { label: ['Physics'], ranges: [{ start: 2, end: 3 }] },
      { label: ['Chemistry'], ranges: [{ start: 4, end: 4 }] },
    ]);
  });

  it('does not request fallback windows for a large one-label answer', async () => {
    const sentenceTexts = Array.from({ length: 80 }, (_, i) => 'sentence ' + i);
    const callLLM = vi.fn(async () => 'Science: 0-79');
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science'], start: 0, end: 79 },
      sentenceTexts,
      callLLM,
      { dependencies: createDependencies() },
    );
    expect(callLLM).toHaveBeenCalledOnce();
    expect(groups).toEqual([{ label: ['Science'], ranges: [{ start: 0, end: 79 }] }]);
  });

  it('surfaces a permanent provider failure after one dispatch', async () => {
    const callLLM = vi.fn(async () => {
      const error = new Error('provider unavailable');
      error.status = 401;
      throw error;
    });
    await expect(
      resplitTopicRange(
        createRuntime(),
        { label: ['Science'], start: 2, end: 4 },
        ['a', 'b', 'c', 'd', 'e'],
        callLLM,
        { dependencies: createDependencies() },
      ),
    ).rejects.toThrow('provider unavailable');
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it('retries a parse failure and returns the recovered split', async () => {
    const callLLM = vi
      .fn()
      .mockResolvedValueOnce('not a range')
      .mockResolvedValueOnce('Physics: 0-0\nChemistry: 1-1');
    const dependencies = createDependencies();
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science'], start: 0, end: 1 },
      ['one', 'two'],
      callLLM,
      { dependencies },
    );
    expect(groups).toHaveLength(2);
    expect(callLLM).toHaveBeenCalledTimes(2);
    expect(dependencies.recordParserMetric).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, scope: 'resplit' }),
    );
    expect(dependencies.recordParserMetric).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, scope: 'resplit', recoveredAfterRetry: true }),
    );
  });

  it('does not recursively split a successful large child topic', async () => {
    const sentenceTexts = Array.from({ length: 50 }, (_, i) => 'sentence ' + i);
    const callLLM = vi.fn(async () => 'Physics: 0-44\nChemistry: 45-49');
    const groups = await resplitTopicRange(
      createRuntime(),
      { label: ['Science'], start: 0, end: 49 },
      sentenceTexts,
      callLLM,
      { dependencies: createDependencies() },
    );
    expect(groups).toHaveLength(2);
    expect(callLLM).toHaveBeenCalledOnce();
  });

  it('sizes dispatched chunks for a long CJK parent path', async () => {
    const contextTokens = 4096;
    const sentenceTexts = Array.from({ length: 41 }, () => '漢'.repeat(200));
    const runtime = createRuntime({
      maxTextChunkChars: getPipelineTextChunkMaxChars(contextTokens),
      maxTopicRangeSentences: getTopicRangeInputMaxSentences(contextTokens),
      preferContentLanguage: true,
    });
    const callLLM = vi.fn(async () => {
      const error = new Error('provider unavailable');
      error.status = 401;
      throw error;
    });
    await expect(
      resplitTopicRange(
        runtime,
        { label: ['研究'.repeat(180)], start: 0, end: 40 },
        sentenceTexts,
        callLLM,
        { dependencies: createDependencies() },
      ),
    ).rejects.toThrow('provider unavailable');
    expect(callLLM).toHaveBeenCalled();
    for (const [request] of callLLM.mock.calls) {
      expect(
        estimateTokens(request.prompt) + runtime.maxTopicRangeSentences * 32,
      ).toBeLessThanOrEqual(contextTokens);
    }
  });
});
