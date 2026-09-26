import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeTopics as computeTopicsWithDefaults } from './topicRangesStage.js';
import { splitTopicRanges } from './topicRangeSplit.js';
import { chunkTopicRangeSentences } from './topicRangeChunking.js';
import { groupsToTopics, rangesToSentenceList } from './topicRangeMapping.js';

import { splitSentences } from './sentenceSplitter.js';
import { markCancellation } from './cancellation.js';
import { TRUNCATED_RESPONSE_ERROR } from '../llm/completionStatus.js';
import { makeRuntime as makePipelineRuntime } from '../../../test/fakes/pipelineFixtures.mjs';

// Stand-in that honors both `warmupFirst` and `stopBurst`, mirroring the real
// parallelMap's dispatch shape. It must model `warmupFirst`: a serial-only
// stand-in stops after the first item either way, so a stage that dropped
// `warmupFirst: true` would still look correct here while really releasing the
// whole burst to the provider.
const parallelMap = vi.fn(async (items, limit, fn, { warmupFirst = false, stopBurst } = {}) => {
  const results = new Array(items.length);
  let next = 0;
  let stopped = false;
  if (warmupFirst && items.length > 1) {
    results[0] = await fn(items[0], 0);
    if (stopBurst && stopBurst(results[0], items[0], 0)) return results;
    next = 1;
  }
  // Without a warmup the first `limit` items are all in flight before any
  // result can stop the burst; stopBurst only prevents the *next* dequeue.
  const workerCount = Math.min(Math.max(limit, 1), Math.max(items.length - next, 1));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!stopped) {
        const index = next++;
        if (index >= items.length) return;
        try {
          results[index] = await fn(items[index], index);
          if (stopBurst && stopBurst(results[index], items[index], index)) stopped = true;
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }),
  );
  return results;
});
const recordParserMetric = vi.fn(async () => undefined);

/** Exercise the production dependency seam without repeating test defaults. */
function computeTopics(input) {
  return computeTopicsWithDefaults({
    ...input,
    dependencies: {
      parallelMap,
      recordParserMetric,
      ...input.dependencies,
    },
  });
}

vi.mock('./sentenceSplitter.js', () => ({
  splitSentences: vi.fn(),
}));

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
});

describe('groupsToTopics', () => {
  it('creates hierarchical names and unique sentence lists', () => {
    const topics = groupsToTopics([
      {
        label: ['Science', 'AI'],
        ranges: [
          { start: 0, end: 1 },
          { start: 1, end: 2 },
        ],
      },
    ]);

    expect(topics).toEqual([
      {
        name: 'Science>AI',
        sentences: [1, 2, 3],
      },
    ]);
  });
});

// Pin the primary chunk size so these retry fixtures stay independent of
// production input limits.
const LONG_CHUNK_SENTENCE_COUNT = 120;
const TWO_CHUNK_SENTENCE_COUNT = LONG_CHUNK_SENTENCE_COUNT + 1;
const LONG_CHUNK_TOPIC_COUNT = 6;
const LONG_CHUNK_TOPIC_SPAN = Math.ceil(LONG_CHUNK_SENTENCE_COUNT / LONG_CHUNK_TOPIC_COUNT);

/** Consecutive ranges partitioning the full first chunk into LONG_CHUNK_TOPIC_COUNT topics. */
function longChunkRanges() {
  return Array.from({ length: LONG_CHUNK_TOPIC_COUNT }, (_, index) => ({
    start: index * LONG_CHUNK_TOPIC_SPAN,
    end: Math.min((index + 1) * LONG_CHUNK_TOPIC_SPAN - 1, LONG_CHUNK_SENTENCE_COUNT - 1),
  }));
}

function makeSentences(count) {
  return Array.from({ length: count }, (_, index) => ({
    text: `S${index}.`,
    start: index * 5,
    end: index * 5 + 3,
  }));
}

/** The full-size chunk is the only one whose markers reach its last sentence. */
function isLongChunkPrompt(prompt) {
  return prompt.includes(`{${LONG_CHUNK_SENTENCE_COUNT - 1}}`);
}

function longChunkResponse() {
  return longChunkRanges()
    .map((range, index) => `Tech>Part ${index + 1}: ${range.start}-${range.end}`)
    .join('\n');
}

/** The same partition as longChunkResponse(), in persisted checkpoint form. */
function longChunkSegments() {
  return longChunkRanges().map((range, index) => ({
    label: ['Tech', `Part ${index + 1}`],
    ...range,
  }));
}

function makeCheckpoint(overrides = {}) {
  return {
    contentRevision: 'rev-1',
    sentenceCount: TWO_CHUNK_SENTENCE_COUNT,
    chunks: [
      { start: 0, sentenceCount: LONG_CHUNK_SENTENCE_COUNT, segments: longChunkSegments() },
      null,
    ],
    ...overrides,
  };
}

function makeRuntime() {
  return makePipelineRuntime({
    summariesDisabled: false,
    maxTextChunkChars: 1_000_000,
    maxTopicRangeSentences: LONG_CHUNK_SENTENCE_COUNT,
  });
}

describe('splitTopicRanges', () => {
  it('uses parent context while returning local ranges and parser metrics', async () => {
    const runtime = makeRuntime();
    runtime.maxTopicRangeSentences = 1;
    const callLLMWithRetry = vi.fn(async () => 'Science>AI>Detail: 0-0');
    const recordMetric = vi.fn();
    const groups = await splitTopicRanges({
      runtime,
      sentenceTexts: ['First.', 'Second.'],
      parentPath: 'Science>AI',
      callLLMWithRetry,
      dependencies: { parallelMap, recordParserMetric: recordMetric },
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).toContain(
      'RESPLIT CONTEXT: Replace the selected topic "Science>AI"',
    );
    expect(recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, scope: 'resplit' }),
    );
    expect(groups).toEqual([
      { label: ['Science', 'AI', 'Detail'], ranges: [{ start: 0, end: 1 }] },
    ]);
  });
});

describe('computeTopics', () => {
  let setTimeoutSpy;

  beforeEach(() => {
    vi.clearAllMocks();
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

  it('finalizes an empty capture without calling the LLM', async () => {
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

  it('uses captured text as the canonical source and preserves literals', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => 'Topic: 0-0');
    const capturedText = 'Literal <b> &amp; text.';
    splitSentences.mockReturnValue([{ text: capturedText, start: 0, end: capturedText.length }]);

    await computeTopics({
      runtime,
      record: {
        html: '<p>stale or differently encoded source</p>',
        captureVersion: 2,
        capturedText,
      },
      callLLMWithRetry,
    });

    expect(splitSentences).toHaveBeenCalledWith(capturedText);
    expect(runtime.update).toHaveBeenCalledWith(expect.objectContaining({ text: capturedText }));
    expect(runtime.update).toHaveBeenCalledWith(
      expect.objectContaining({ sentences: [capturedText] }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      'normalizing_text_start',
      expect.objectContaining({ source: 'captured_text', capturedTextLength: capturedText.length }),
      { verbose: true },
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

  it('does not request an automatic resplit for an oversized primary topic', async () => {
    const runtime = makeRuntime();
    splitSentences.mockReturnValue(
      Array.from({ length: 45 }, (_, index) => ({
        text: `Sentence ${index}.`,
        start: index * 12,
        end: index * 12 + 11,
      })),
    );
    const callLLMWithRetry = vi.fn(async () => 'Science>AI: 0-44');

    const result = await computeTopics({
      runtime,
      record: { html: '<p>x</p>' },
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).not.toContain('RESPLIT CONTEXT');
    expect(result.topics).toEqual([
      { name: 'Science>AI', sentences: Array.from({ length: 45 }, (_, index) => index + 1) },
    ]);
  });

  it('does not record parser metrics when cancellation wins before primary parsing', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    recordParserMetric.mockClear();
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
});

describe('topic-ranges incremental retry', () => {
  let setTimeoutSpy;

  beforeEach(() => {
    vi.clearAllMocks();
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
    splitSentences.mockReturnValue(makeSentences(LONG_CHUNK_SENTENCE_COUNT * 2 + 1));
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
      chunks: [
        { start: 0, sentenceCount: LONG_CHUNK_SENTENCE_COUNT, segments: longChunkSegments() },
        null,
      ],
    });

    // The successful sibling is checkpointed after the first parse round,
    // before the retry loop exhausts. Later retries may refresh the same
    // checkpoint, but durability must not depend on reaching this catch.
    expect(
      runtime.update.mock.calls.filter(([patch]) => patch.topic_range_chunks).length,
    ).toBeGreaterThan(1);
  });

  it('never checkpoints a chunk whose response the provider truncated', async () => {
    const runtime = makeRuntime();
    // callLLMWithRetry rejects a truncated response rather than returning its
    // partial text, so the chunk stays pending instead of being parsed into
    // coverage the model never produced.
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (isLongChunkPrompt(prompt)) return longChunkResponse();
      throw new Error(TRUNCATED_RESPONSE_ERROR);
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toThrow(/truncated/i);

    for (const [patch] of runtime.update.mock.calls) {
      if (!patch.topic_range_chunks) continue;
      // Only the complete sibling is durable; the truncated chunk stays null.
      expect(patch.topic_range_chunks.chunks[1]).toBeNull();
    }
    // The stage's opening write clears topics; no write may add any.
    expect(runtime.update.mock.calls.some(([patch]) => patch.topics?.length)).toBe(false);
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
        { start: 0, sentenceCount: LONG_CHUNK_SENTENCE_COUNT, segments: longChunkSegments() },
        {
          start: LONG_CHUNK_SENTENCE_COUNT,
          sentenceCount: 1,
          segments: [
            {
              label: ['Tech', 'Last'],
              start: LONG_CHUNK_SENTENCE_COUNT,
              end: LONG_CHUNK_SENTENCE_COUNT,
            },
          ],
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
    // Warmup is serialized: the ownership-losing checkpoint write happens
    // after the first request, before the burst can dispatch its sibling.
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
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

  it('keeps completed chunks when cancellation interrupts a sibling request and resumes the rest', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    runtime.maxTextChunkChars = 1_000_000;
    runtime.maxTopicRangeSentences = 1;
    const sentenceCount = 3;
    splitSentences.mockReturnValue(makeSentences(sentenceCount));

    let persistedCheckpoint;
    let checkpointWrites = 0;
    runtime.update.mockImplementation(async (patch) => {
      if (patch.topic_range_chunks) {
        checkpointWrites++;
      }
      if (patch.topic_range_chunks && checkpointWrites === 2) {
        persistedCheckpoint = structuredClone(patch.topic_range_chunks);
        controller.abort();
      }
    });
    const abortError = () => {
      const error = new Error('The user aborted a request.');
      error.name = 'AbortError';
      return error;
    };
    let pendingRequestStarted = false;
    const callLLMWithRetry = vi.fn(async ({ signal }) => {
      if (signal.aborted) throw abortError();
      if (callLLMWithRetry.mock.calls.length === 3) {
        pendingRequestStarted = true;
        await new Promise((_, reject) =>
          signal.addEventListener('abort', () => reject(abortError())),
        );
      }
      return 'Tech>Part: 0-0';
    });

    await expect(
      computeTopics({
        runtime,
        record: { html: '<p>x</p>', contentRevision: 'rev-1' },
        callLLMWithRetry,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(pendingRequestStarted).toBe(true);
    expect(checkpointWrites).toBe(2);
    expect(persistedCheckpoint).toMatchObject({
      contentRevision: 'rev-1',
      sentenceCount,
      chunks: [
        expect.objectContaining({ segments: expect.any(Array) }),
        expect.objectContaining({ segments: expect.any(Array) }),
        null,
      ],
    });

    const resumedRuntime = makeRuntime();
    resumedRuntime.maxTextChunkChars = 1_000_000;
    resumedRuntime.maxTopicRangeSentences = 1;
    const resumedCall = vi.fn(async () => 'Tech>Last: 0-0');
    await computeTopics({
      runtime: resumedRuntime,
      record: {
        html: '<p>x</p>',
        contentRevision: 'rev-1',
        topic_range_chunks: persistedCheckpoint,
      },
      callLLMWithRetry: resumedCall,
    });

    expect(resumedCall).toHaveBeenCalledTimes(1);
    expect(resumedCall.mock.calls[0][0].prompt).toContain('{0}');
    expect(resumedRuntime.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ topic_range_chunks: null }),
    );
    expect(runtime.update.mock.calls.filter(([patch]) => patch.topic_range_chunks).length).toBe(2);
  });

  it('serializes delayed checkpoint saves and finishes with a complete snapshot', async () => {
    const runtime = makeRuntime();
    runtime.maxTextChunkChars = 1_000_000;
    runtime.maxTopicRangeSentences = 1;
    splitSentences.mockReturnValue(makeSentences(3));
    let releaseSecond;
    let activeSaves = 0;
    let maxActiveSaves = 0;
    const snapshots = [];
    const saveCheckpoint = vi.fn(async (_runtime, _record, chunkStates) => {
      activeSaves++;
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves);
      snapshots.push(chunkStates.map((state) => state.segments));
      if (saveCheckpoint.mock.calls.length === 2) {
        await new Promise((resolve) => {
          releaseSecond = resolve;
        });
      }
      activeSaves--;
    });
    const run = computeTopics({
      runtime,
      record: { html: '<p>x</p>', contentRevision: 'rev-1' },
      callLLMWithRetry: vi.fn(async () => 'Tech>Part: 0-0'),
      dependencies: { saveCheckpoint },
    });

    await vi.waitFor(() => expect(saveCheckpoint).toHaveBeenCalledTimes(2));
    for (let index = 0; index < 20; index++) await Promise.resolve();
    expect(saveCheckpoint).toHaveBeenCalledTimes(2);
    expect(maxActiveSaves).toBe(1);
    releaseSecond();
    await run;

    expect(maxActiveSaves).toBe(1);
    expect(snapshots).toHaveLength(3);
    expect(snapshots.at(-1).every((segments) => Array.isArray(segments))).toBe(true);
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
