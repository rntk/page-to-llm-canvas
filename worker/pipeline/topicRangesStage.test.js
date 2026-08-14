import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { markCancellation } from './cancellation.js';
import { MAX_TAGGED_CHARS, TOPIC_RANGE_INPUT_MAX_SENTENCES } from './pipelineConfig.js';

vi.mock('../llm/llm.js', () => ({
  // Serial stand-in that still honors `stopBurst`, so a stage relying on it to
  // stop dequeuing is exercised here rather than silently bypassed.
  parallelMap: async (items, _limit, fn, { stopBurst } = {}) => {
    const result = [];
    for (let index = 0; index < items.length; index++) {
      result.push(await fn(items[index], index));
      if (stopBurst && stopBurst(result[index], items[index], index)) break;
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
  it('splits at newline boundaries and bounds pathological individual lines', () => {
    expect(chunkTaggedText('one\ntwo\nthree', 8)).toEqual(['one\ntwo', 'three']);
    expect(chunkTaggedText('oversized', 3)).toEqual(['o…d']);
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

  it('splits at the character boundary while retaining every sentence marker', () => {
    const chunks = chunkTopicRangeSentences(['12345', '67890', 'x'.repeat(20)], 10, 10);
    expect(chunks.map(({ start, sentenceCount }) => ({ start, sentenceCount }))).toEqual([
      { start: 0, sentenceCount: 1 },
      { start: 1, sentenceCount: 1 },
      { start: 2, sentenceCount: 1 },
    ]);
    expect(chunks.every((chunk) => chunk.tagged.length <= 10)).toBe(true);
    expect(chunks[2].tagged).toMatch(/^\{0\} x+…x+$/);
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

// 241 sentences split into exactly two chunks (240 + 1) at
// TOPIC_RANGE_INPUT_MAX_SENTENCES, which is the smallest article that can show
// one chunk failing while another succeeds.
const TWO_CHUNK_SENTENCE_COUNT = 241;
const LONG_CHUNK_TOPIC_COUNT = 6;

function makeSentences(count) {
  return Array.from({ length: count }, (_, index) => ({
    text: `S${index}.`,
    start: index * 5,
    end: index * 5 + 3,
  }));
}

/** The 240-sentence chunk is the only one whose markers reach {239}. */
function isLongChunkPrompt(prompt) {
  return prompt.includes('{239}');
}

function longChunkResponse() {
  return Array.from(
    { length: LONG_CHUNK_TOPIC_COUNT },
    (_, index) => `Tech>Part ${index + 1}: ${index * 40}-${index * 40 + 39}`,
  ).join('\n');
}

/** The same partition as longChunkResponse(), in persisted checkpoint form. */
function longChunkSegments() {
  return Array.from({ length: LONG_CHUNK_TOPIC_COUNT }, (_, index) => ({
    label: ['Tech', `Part ${index + 1}`],
    start: index * 40,
    end: index * 40 + 39,
  }));
}

function makeCheckpoint(overrides = {}) {
  return {
    contentRevision: 'rev-1',
    sentenceCount: TWO_CHUNK_SENTENCE_COUNT,
    chunks: [{ start: 0, sentenceCount: 240, segments: longChunkSegments() }, null],
    ...overrides,
  };
}

function makeRuntime() {
  return {
    signal: undefined,
    preferContentLanguage: false,
    summariesDisabled: false,
    maxTextChunkChars: MAX_TAGGED_CHARS,
    maxTopicRangeSentences: TOPIC_RANGE_INPUT_MAX_SENTENCES,
    update: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
}

describe('computeTopics', () => {
  let setTimeoutSpy;

  beforeEach(() => {
    // Retry backoff is real (2s/4s/8s) — run it instantly so the retry-scope
    // tests below don't spend 14 seconds sleeping.
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    });
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

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
    expect(runtime.update.mock.calls[0][0]).toMatchObject({
      status: 'splitting',
      source_summary_units: {},
    });
  });

  it('accepts execution, telemetry, and checkpoint capabilities without module mocks', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => 'Science: 0-1');
    const executeInParallel = vi.fn(async (items, _limit, fn) => Promise.all(items.map(fn)));
    const recordParser = vi.fn(async () => undefined);
    const readCheckpoint = vi.fn(() => null);
    const saveCheckpoint = vi.fn(async () => undefined);
    splitSentences.mockReturnValue([
      { text: 'Alpha.', start: 0, end: 6 },
      { text: 'Beta.', start: 7, end: 12 },
    ]);

    await computeTopics({
      runtime,
      record: { html: '<p>Alpha. Beta.</p>', contentRevision: 'rev-di' },
      callLLMWithRetry,
      dependencies: {
        parallelMap: executeInParallel,
        recordParserMetric: recordParser,
        readCheckpoint,
        saveCheckpoint,
      },
    });

    expect(executeInParallel).toHaveBeenCalled();
    expect(recordParser).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(readCheckpoint).toHaveBeenCalled();
    expect(saveCheckpoint).toHaveBeenCalled();
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

  it('records a per-chunk failure sample without discarding the sibling chunk that parsed', async () => {
    const runtime = makeRuntime();
    recordParserMetric.mockClear();
    splitSentences.mockReturnValue(makeSentences(TWO_CHUNK_SENTENCE_COUNT));
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'not parseable',
    );

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError', retryable: true });

    const primarySamples = recordParserMetric.mock.calls
      .map(([sample]) => sample)
      .filter((sample) => sample.scope === 'primary');
    // Four attempts: the short chunk fails every time, the long one parses once
    // and is never re-parsed, so there is exactly one success sample.
    expect(primarySamples.filter((sample) => sample.ok)).toHaveLength(1);
    expect(primarySamples.filter((sample) => !sample.ok)).toHaveLength(4);
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

describe('topic-ranges incremental retry', () => {
  let setTimeoutSpy;

  beforeEach(() => {
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
      if (typeof fn === 'function') fn();
      return 0;
    });
    splitSentences.mockReturnValue(makeSentences(TWO_CHUNK_SENTENCE_COUNT));
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  it('re-requests only the chunk whose provider call failed', async () => {
    const runtime = makeRuntime();
    let shortChunkCalls = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      shortChunkCalls++;
      if (shortChunkCalls === 1) {
        throw Object.assign(new Error('provider unavailable'), { status: 503 });
      }
      return 'Tech>Last: 0';
    });

    const result = await computeTopics({
      runtime,
      record: { html: '<p>x</p>', contentRevision: 'rev-1' },
      callLLMWithRetry,
    });

    expect(result.topics).toHaveLength(LONG_CHUNK_TOPIC_COUNT + 1);
    // Three requests total, not four: the long chunk's response survived its
    // sibling's failure instead of being discarded by the fan-out.
    expect(callLLMWithRetry).toHaveBeenCalledTimes(3);
    expect(
      callLLMWithRetry.mock.calls.filter(([{ prompt }]) => isLongChunkPrompt(prompt)),
    ).toHaveLength(1);
  });

  it('gives up immediately when a chunk fails with a permanent 4xx', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError', retryable: false });

    // One attempt only: no amount of retrying fixes a rejected key, so the
    // three backoff rounds are not spent.
    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('does not dispatch the queued chunks after a permanent warmup failure', async () => {
    const runtime = makeRuntime();
    // Three chunks, so a failed warmup still leaves a burst to (not) release.
    splitSentences.mockReturnValue(makeSentences(TOPIC_RANGE_INPUT_MAX_SENTENCES * 2 + 1));
    const callLLMWithRetry = vi.fn(async () => {
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError', retryable: false });

    // Exactly one request: the warmup's 401 condemns its siblings too, so they
    // are never sent, and the non-retryable aggregate ends the stage.
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_ranges_llm_skipped',
      expect.objectContaining({ skippedChunkCount: 2, skippedChunkIndexes: [1, 2] }),
    );
  });

  it('gives up immediately when a provider configuration error is non-retryable', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      throw Object.assign(new Error('No LLM provider configured'), { retryable: false });
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError', retryable: false });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it('waits out a 429 Retry-After before re-dispatching, instead of the plain backoff', async () => {
    const runtime = makeRuntime();
    let shortChunkCalls = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      shortChunkCalls++;
      if (shortChunkCalls === 1) {
        throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 30_000 });
      }
      return 'Tech>Last: 0';
    });

    await computeTopics({
      runtime,
      record: { html: '<p>x</p>', contentRevision: 'rev-1' },
      callLLMWithRetry,
    });

    // The provider's cooldown, not the 2s first backoff step.
    expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([30_000]);
  });

  it('caps a provider cooldown so an absurd Retry-After cannot park the stage', async () => {
    const runtime = makeRuntime();
    let shortChunkCalls = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      shortChunkCalls++;
      if (shortChunkCalls === 1) {
        throw Object.assign(new Error('rate limited'), {
          status: 429,
          retryAfterMs: 24 * 60 * 60 * 1000,
        });
      }
      return 'Tech>Last: 0';
    });

    await computeTopics({
      runtime,
      record: { html: '<p>x</p>', contentRevision: 'rev-1' },
      callLLMWithRetry,
    });

    expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([60_000]);
  });

  it('keeps the exponential backoff when the failure carries no cooldown', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'not parseable',
    );

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError' });

    expect(setTimeoutSpy.mock.calls.map(([, delay]) => delay)).toEqual([2000, 4000, 8000]);
  });

  it('persists the chunks that succeeded when the stage finally fails', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'not parseable',
    );

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError' });

    const saved = runtime.update.mock.calls
      .map(([patch]) => patch)
      .find((patch) => patch.topic_range_chunks);
    expect(saved.topic_range_chunks).toEqual({
      contentRevision: 'rev-1',
      sentenceCount: TWO_CHUNK_SENTENCE_COUNT,
      chunks: [{ start: 0, sentenceCount: 240, segments: longChunkSegments() }, null],
    });

    // The successful sibling is checkpointed after the first parse round,
    // before the retry loop exhausts. Later retries may refresh the same
    // checkpoint, but durability must not depend on reaching this catch.
    expect(
      runtime.update.mock.calls.filter(([patch]) => patch.topic_range_chunks).length,
    ).toBeGreaterThan(1);
  });

  it('checkpoints every parsed chunk before the final topic write clears it', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'Tech>Last: 0',
    );

    await computeTopics({
      runtime,
      record: { html: '<p>x</p>', contentRevision: 'rev-1' },
      callLLMWithRetry,
    });

    const checkpoints = runtime.update.mock.calls
      .map(([patch]) => patch.topic_range_chunks)
      .filter(Boolean);
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.at(-1)).toEqual({
      contentRevision: 'rev-1',
      sentenceCount: TWO_CHUNK_SENTENCE_COUNT,
      chunks: [
        { start: 0, sentenceCount: 240, segments: longChunkSegments() },
        {
          start: 240,
          sentenceCount: 1,
          segments: [{ label: ['Tech', 'Last'], start: 240, end: 240 }],
        },
      ],
    });
    expect(runtime.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic_range_chunks: null }),
    );
  });

  it('stops retrying when a checkpoint write loses run ownership', async () => {
    const runtime = makeRuntime();
    const superseded = markCancellation(new Error('Pipeline run is no longer current'));
    superseded.name = 'AbortError';
    runtime.update.mockImplementation(async (patch) => {
      if (patch.topic_range_chunks) throw superseded;
    });
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'not parseable',
    );

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toBe(superseded);

    expect(runtime.signal).toBeUndefined();
    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_ranges_checkpoint_save_failed',
      expect.anything(),
      expect.anything(),
    );
  });

  it('skips the checkpoint write when the record has no revision to pin it to', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'not parseable',
    );

    await expect(
      computeTopics({ runtime, record: { html: '<p>x</p>' }, callLLMWithRetry }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError' });

    // readTopicRangeChunkCheckpoint would reject such a checkpoint anyway, so
    // writing one only costs a content-doc write.
    expect(
      runtime.update.mock.calls.map(([patch]) => patch).some((patch) => patch.topic_range_chunks),
    ).toBe(false);
  });

  it('carries a sibling chunk 429 onto the aggregate even behind a parse failure', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return 'not parseable';
      throw Object.assign(new Error('rate limited'), { status: 429, retryAfterMs: 30_000 });
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'TopicRangeChunkError', status: 429, retryAfterMs: 30_000 });
  });

  it('resumes a persisted checkpoint and requests only the missing chunk', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => 'Tech>Last: 0');

    const result = await computeTopics({
      runtime,
      record: {
        html: '<p>x</p>',
        contentRevision: 'rev-1',
        topic_range_chunks: makeCheckpoint(),
      },
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(isLongChunkPrompt(callLLMWithRetry.mock.calls[0][0].prompt)).toBe(false);
    expect(result.topics.map((topic) => topic.name)).toEqual([
      ...Array.from({ length: LONG_CHUNK_TOPIC_COUNT }, (_, i) => `Tech>Part ${i + 1}`),
      'Tech>Last',
    ]);
    // Cleared in the same write that stores the topics it produced.
    expect(runtime.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic_range_chunks: null }),
    );
  });

  it('discards a checkpoint from a different content revision and re-requests everything', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      isLongChunkPrompt(prompt) ? longChunkResponse() : 'Tech>Last: 0',
    );

    await computeTopics({
      runtime,
      record: {
        html: '<p>x</p>',
        contentRevision: 'rev-2',
        topic_range_chunks: makeCheckpoint({ contentRevision: 'rev-1' }),
      },
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    const cleared = runtime.update.mock.calls
      .map(([patch]) => patch)
      .find((patch) => 'sentences' in patch);
    expect(cleared.topic_range_chunks).toBeNull();
  });
});
