import { describe, expect, it, vi } from 'vitest';
import {
  chunkTaggedText,
  chunkTopicRangeSentences,
  computeTopics,
  groupsToTopics,
  mapTextOffsetToHtml,
  rangesToSentenceList,
} from './topicRangesStage.js';

import { splitSentences } from './sentenceSplitter.js';
import { recordParserMetric } from '../metrics/parser.js';
import { recordResplitRun } from '../metrics/resplit.js';

vi.mock('../llm/llm.js', () => ({
  parallelMap: async (items, _limit, fn) => {
    const result = [];
    for (let index = 0; index < items.length; index++) {
      result.push(await fn(items[index], index));
    }
    return result;
  },
}));

vi.mock('../metrics/parser.js', () => ({
  recordParserMetric: vi.fn(async () => undefined),
}));

vi.mock('../metrics/resplit.js', async () => {
  const actual = await vi.importActual('../metrics/resplit.js');
  return { ...actual, recordResplitRun: vi.fn(async () => undefined) };
});

vi.mock('./sentenceSplitter.js', () => ({
  splitSentences: vi.fn(),
}));

describe('chunkTaggedText', () => {
  it('splits only at newline boundaries and keeps oversized lines intact', () => {
    expect(chunkTaggedText('one\ntwo\nthree', 8)).toEqual(['one\ntwo', 'three']);
    expect(chunkTaggedText('oversized', 3)).toEqual(['oversized']);
    expect(chunkTaggedText('', 3)).toEqual(['']);
  });
});

describe('chunkTopicRangeSentences', () => {
  it('restarts local markers and preserves global starts', () => {
    expect(chunkTopicRangeSentences([{ text: 'A' }, 'B', 'C'], 100, 2)).toEqual([
      { start: 0, sentenceCount: 2, tagged: '{0} A\n{1} B' },
      { start: 2, sentenceCount: 1, tagged: '{0} C' },
    ]);
  });

  it('splits at the character boundary without dropping a long sentence', () => {
    const chunks = chunkTopicRangeSentences(['12345', '67890', 'x'.repeat(20)], 10, 10);
    expect(chunks.map(({ start, sentenceCount }) => ({ start, sentenceCount }))).toEqual([
      { start: 0, sentenceCount: 1 },
      { start: 1, sentenceCount: 1 },
      { start: 2, sentenceCount: 1 },
    ]);
  });

  it('returns no chunks for empty input and validates positive limits', () => {
    expect(chunkTopicRangeSentences([])).toEqual([]);
    expect(() => chunkTopicRangeSentences(['a'], 0)).toThrow('maxChars must be positive');
    expect(() => chunkTopicRangeSentences(['a'], 10, 1.5)).toThrow(
      'maxSentences must be a positive integer',
    );
  });
});

describe('range and offset helpers', () => {
  it('expands, sorts, and deduplicates inclusive zero-based ranges', () => {
    expect(
      rangesToSentenceList([
        { start: 3, end: 4 },
        { start: 0, end: 2 },
        { start: 2, end: 3 },
      ]),
    ).toEqual([1, 2, 3, 4, 5]);
  });

  it('clamps text offsets to the mapping bounds', () => {
    expect(mapTextOffsetToHtml([10, 20, 30], 1)).toBe(20);
    expect(mapTextOffsetToHtml([10, 20, 30], -1)).toBe(10);
    expect(mapTextOffsetToHtml([10, 20, 30], 99)).toBe(30);
  });
});

describe('groupsToTopics', () => {
  it('creates hierarchical names, unique sentence lists, spans, and ranges', () => {
    const sentenceObjs = [
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
    ];
    const topics = groupsToTopics(
      [
        {
          label: ['Science', 'AI'],
          ranges: [
            { start: 0, end: 1 },
            { start: 1, end: 2 },
          ],
        },
      ],
      sentenceObjs,
      [100, 101, 102, 103, 104, 105, 106, 107, 108],
    );

    expect(topics).toEqual([
      {
        name: 'Science>AI',
        sentences: [1, 2, 3],
        sentence_spans: [
          { sentence: 1, start: 100, end: 102 },
          { sentence: 2, start: 103, end: 105 },
          { sentence: 3, start: 106, end: 108 },
        ],
        ranges: [
          { sentence_start: 1, sentence_end: 2, start: 100, end: 105 },
          { sentence_start: 2, sentence_end: 3, start: 103, end: 108 },
        ],
      },
    ]);
  });
});

function makeRuntime() {
  return {
    signal: undefined,
    preferContentLanguage: false,
    summariesDisabled: false,
    update: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
}

describe('computeTopics', () => {
  it('finalizes an HTML record with no sentences without calling the LLM', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn();
    splitSentences.mockReturnValue([]);

    const result = await computeTopics({ runtime, record: { html: '' }, callLLMWithRetry });

    expect(result).toEqual({ topics: null, sentenceTexts: [] });
    expect(callLLMWithRetry).not.toHaveBeenCalled();
    expect(runtime.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        summariesDisabled: false,
        summariesIncomplete: false,
      }),
    );
    expect(runtime.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'done',
        topics: [],
        progress: { stage: 'done', done: 0, total: 0 },
      }),
    );
  });

  it('parses an injected LLM response and returns mapped topics', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => 'Science>AI: 0-1');
    splitSentences.mockReturnValue([
      { text: 'Alpha topic.', start: 0, end: 12 },
      { text: 'Beta topic.', start: 13, end: 24 },
    ]);
    const result = await computeTopics({
      runtime,
      record: { html: '<p>Alpha topic. Beta topic.</p>', contentRevision: 'rev-current' },
      callLLMWithRetry,
    });

    expect(result.sentenceTexts).toEqual(['Alpha topic.', 'Beta topic.']);
    expect(result.topics).toHaveLength(1);
    expect(result.topics[0]).toMatchObject({
      name: 'Science>AI',
      sentences: [1, 2],
    });
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(runtime.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'summarizing',
        topics: result.topics,
        summaryCheckpointContentRevision: 'rev-current',
      }),
    );
  });

  it('propagates cancellation during resplit instead of recording a resplit error', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    recordParserMetric.mockClear();
    recordResplitRun.mockClear();
    // One oversized range (> TOPIC_RANGE_MAX_SENTENCES) so refinement runs.
    splitSentences.mockReturnValue(
      Array.from({ length: 45 }, (_, index) => ({
        text: `Sentence ${index}.`,
        start: index * 12,
        end: index * 12 + 11,
      })),
    );
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    let call = 0;
    const callLLMWithRetry = vi.fn(async () => {
      call++;
      if (call === 1) return 'Science>AI: 0-44';
      controller.abort();
      throw abortError;
    });

    await expect(
      computeTopics({ runtime, record: { html: '<p>x</p>' }, callLLMWithRetry }),
    ).rejects.toBe(abortError);

    expect(runtime.log).not.toHaveBeenCalledWith('topic_ranges_resplit_error', expect.anything());
    expect(runtime.log).not.toHaveBeenCalledWith('topic_ranges_oversize_error', expect.anything());
    // The already-completed primary parse remains a valid sample, but the
    // cancelled resplit must not create parser or run-level resplit metrics.
    expect(recordParserMetric).toHaveBeenCalledTimes(1);
    expect(recordParserMetric).toHaveBeenCalledWith(expect.objectContaining({ scope: 'primary' }));
    expect(recordResplitRun).not.toHaveBeenCalled();
  });

  it('does not record parser or resplit metrics when cancellation wins before primary parsing', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    recordParserMetric.mockClear();
    recordResplitRun.mockClear();
    splitSentences.mockReturnValue([
      { text: 'Alpha topic.', start: 0, end: 12 },
      { text: 'Beta topic.', start: 13, end: 24 },
    ]);
    const callLLMWithRetry = vi.fn(async () => {
      controller.abort();
      return 'Science>AI: 0-1';
    });

    await expect(
      computeTopics({ runtime, record: { html: '<p>x</p>' }, callLLMWithRetry }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(recordParserMetric).not.toHaveBeenCalled();
    expect(recordResplitRun).not.toHaveBeenCalled();
  });

  it('does not record a resplit run when cancellation lands after successful refinement', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    runtime.log.mockImplementation(async (stage) => {
      if (stage === 'topic_ranges_oversize_refined') {
        controller.abort();
        return;
      }
      if (controller.signal.aborted) {
        const error = new Error('Pipeline run was cancelled');
        error.name = 'AbortError';
        throw error;
      }
    });
    recordResplitRun.mockClear();
    splitSentences.mockReturnValue(
      Array.from({ length: 45 }, (_, index) => ({
        text: `Sentence ${index}.`,
        start: index * 12,
        end: index * 12 + 11,
      })),
    );
    let call = 0;
    const callLLMWithRetry = vi.fn(async () => {
      call++;
      return call === 1 ? 'Science>AI: 0-44' : 'Science>One: 0-21\nScience>Two: 22-44';
    });

    await expect(
      computeTopics({ runtime, record: { html: '<p>x</p>' }, callLLMWithRetry }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(recordResplitRun).not.toHaveBeenCalled();
  });
});
