import { describe, expect, it, vi } from 'vitest';
import {
  boundariesToRanges,
  DECISION_BATCH_SIZE,
  DECISION_MAX_ATTEMPTS,
  decideTopicBoundaries,
  summarizeBoundaries,
} from './decisionTopicBoundaries.js';
import { makeRuntime } from '../../../test/fakes/pipelineFixtures.mjs';
import { LLM_TASK_TYPES } from '../metrics/llm.js';

function makeSentences(count) {
  return Array.from({ length: count }, (_, index) => ({ text: `S${index + 1}.` }));
}

function answer(split) {
  return {
    choice: split >= 0.5 ? 'split' : 'continue',
    probabilities: { split, continue: 1 - split },
  };
}

/** A decision stub that answers every question from `probabilityFor(id)`. */
function makeDecide(probabilityFor = () => 0) {
  return vi.fn(async (_state, questions) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [id, answer(probabilityFor(id))]),
    ),
  }));
}

function oversizedError(status = 400, body = 'input is too large for the context') {
  return Object.assign(new Error(`HTTP ${status}`), { status, body });
}

/** Runs batches one at a time so call order is deterministic. */
async function sequentialMap(items, _limit, fn) {
  const results = [];
  for (const [index, item] of items.entries()) results.push(await fn(item, index));
  return results;
}

const noSleep = vi.fn(async () => undefined);

const questionIds = (call) => Object.keys(call[1]);
const contentIds = (call) => call[0].content.map((item) => item.id);

describe('decideTopicBoundaries', () => {
  it('asks one question per gap with 1-based right-hand sentence ids', async () => {
    const decide = makeDecide((id) => (id === 'b3' ? 0.9 : 0.1));

    const boundaries = await decideTopicBoundaries({ decide, sentences: makeSentences(4) });

    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions] = decide.mock.calls[0];
    expect(Object.keys(questions)).toEqual(['b2', 'b3', 'b4']);
    expect(questions.b3).toMatchObject({ type: 'choice' });
    expect(questions.b3.instructions).toContain('{2}');
    expect(questions.b3.instructions).toContain('{3}');
    expect(Object.keys(questions.b3.criteria)).toEqual(['continue', 'split']);
    expect(state.task).toEqual(expect.any(String));
    expect(state.content.map((item) => item.text)).toEqual(['S1.', 'S2.', 'S3.', 'S4.']);
    expect(boundaries).toEqual([
      { after: 0, value: 0.1, split: false },
      { after: 1, value: 0.9, split: true },
      { after: 2, value: 0.1, split: false },
    ]);
  });

  it('rejoins continued pieces and asks only about real sentence gaps', async () => {
    const text = 'Intro here. Four kinds: alpha one; beta two; gamma three. Next topic.';
    const sentences = [
      { text: 'Intro here.', start: 0, end: 11 },
      { text: 'Four kinds: alpha one;', start: 12, end: 34 },
      { text: 'beta two;', start: 35, end: 44, continued: true },
      { text: 'gamma three.', start: 45, end: 57, continued: true },
      { text: 'Next topic.', start: 58, end: 69 },
    ];
    const decide = makeDecide((id) => (id === 'b3' ? 0.9 : 0.2));
    const runtime = makeRuntime();

    const boundaries = await decideTopicBoundaries({ decide, sentences, text, runtime });

    expect(decide).toHaveBeenCalledTimes(1);
    const [state, questions] = decide.mock.calls[0];
    expect(Object.keys(questions)).toEqual(['b2', 'b3']);
    expect(state.content.map((item) => [item.id, item.text])).toEqual([
      [1, 'Intro here.'],
      [2, 'Four kinds: alpha one; beta two; gamma three.'],
      [3, 'Next topic.'],
    ]);
    expect(boundaries).toEqual([
      { after: 0, value: 0.2, split: false },
      { after: 1, value: null, split: false, withinSentence: true },
      { after: 2, value: null, split: false, withinSentence: true },
      { after: 3, value: 0.9, split: true },
    ]);
    expect(boundariesToRanges(5, boundaries)).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 4 },
    ]);
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_decided',
      expect.objectContaining({ gapCount: 2, withinSentenceGapCount: 2 }),
    );
  });

  it('records trailing within-sentence gaps and joins pieces without offsets', async () => {
    const sentences = [
      { text: 'A one.' },
      { text: 'B starts' },
      { text: 'and ends.', continued: true },
    ];
    const decide = makeDecide(() => 0.7);

    const boundaries = await decideTopicBoundaries({ decide, sentences });

    expect(decide.mock.calls[0][0].content.map((item) => item.text)).toEqual([
      'A one.',
      'B starts and ends.',
    ]);
    expect(boundaries).toEqual([
      { after: 0, value: 0.7, split: true },
      { after: 1, value: null, split: false, withinSentence: true },
    ]);
  });

  it('makes no request when every piece belongs to one sentence', async () => {
    const decide = makeDecide();
    const boundaries = await decideTopicBoundaries({
      decide,
      sentences: [{ text: 'a b' }, { text: 'c d', continued: true }],
    });
    expect(decide).not.toHaveBeenCalled();
    expect(boundaries).toEqual([{ after: 0, value: null, split: false, withinSentence: true }]);
  });

  it('makes no request for zero or one sentence', async () => {
    const decide = makeDecide();
    expect(await decideTopicBoundaries({ decide, sentences: [] })).toEqual([]);
    expect(await decideTopicBoundaries({ decide, sentences: makeSentences(1) })).toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('batches gaps and includes context sentences on each side', async () => {
    const decide = makeDecide();

    const boundaries = await decideTopicBoundaries({
      decide,
      sentences: makeSentences(10),
      batchSize: 2,
      contextSentences: 1,
    });

    expect(decide.mock.calls.map(questionIds)).toEqual([
      ['b2', 'b3'],
      ['b4', 'b5'],
      ['b6', 'b7'],
      ['b8', 'b9'],
      ['b10'],
    ]);
    expect(contentIds(decide.mock.calls[0])).toEqual([1, 2, 3, 4]);
    expect(contentIds(decide.mock.calls[1])).toEqual([2, 3, 4, 5, 6]);
    expect(contentIds(decide.mock.calls[4])).toEqual([8, 9, 10]);
    expect(boundaries.map((boundary) => boundary.after)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('defaults to a batch of eight gaps', async () => {
    const decide = makeDecide();
    await decideTopicBoundaries({ decide, sentences: makeSentences(20) });
    expect(DECISION_BATCH_SIZE).toBe(8);
    expect(decide.mock.calls.map((call) => questionIds(call).length)).toEqual([8, 8, 3]);
  });

  it('reports paragraph breaks from the source text between sentences', async () => {
    const decide = makeDecide();
    const text = 'A one.\n\nB two. C three.\n D four.';
    const sentences = [
      { text: 'A one.', start: 0, end: 6 },
      { text: 'B two.', start: 8, end: 14 },
      { text: 'C three.', start: 15, end: 23 },
      { text: 'D four.', start: 25, end: 32 },
    ];

    await decideTopicBoundaries({ decide, sentences, text });

    expect(decide.mock.calls[0][0].content.map((item) => item.paragraph_break_before)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it('treats sentences without offsets as having no paragraph break', async () => {
    const decide = makeDecide();
    await decideTopicBoundaries({ decide, sentences: makeSentences(2), text: 'A.\n\nB.' });
    expect(decide.mock.calls[0][0].content.every((item) => !item.paragraph_break_before)).toBe(
      true,
    );
  });

  it('shortens overlong sentences in the middle', async () => {
    const decide = makeDecide();
    const sentences = [{ text: `${'a'.repeat(30)}${'z'.repeat(30)}` }, { text: 'short' }];

    await decideTopicBoundaries({ decide, sentences, maxSentenceChars: 11 });

    const [first, second] = decide.mock.calls[0][0].content;
    expect(first.text).toBe('aaaaa…zzzzz');
    expect(second.text).toBe('short');
  });

  it('splits when the probability meets the threshold', async () => {
    const probabilities = { b2: 0.5, b3: 0.7, b4: 0.8 };
    const decide = makeDecide((id) => probabilities[id]);

    const defaults = await decideTopicBoundaries({ decide, sentences: makeSentences(4) });
    const strict = await decideTopicBoundaries({
      decide,
      sentences: makeSentences(4),
      threshold: 0.8,
    });

    expect(defaults.map((boundary) => boundary.split)).toEqual([true, true, true]);
    expect(strict.map((boundary) => boundary.split)).toEqual([false, false, true]);
  });

  it('passes the runtime abort signal and logs progress', async () => {
    const decide = makeDecide();
    const controller = new AbortController();
    const runtime = makeRuntime({ signal: controller.signal });

    await decideTopicBoundaries({ decide, sentences: makeSentences(3), runtime });

    expect(decide.mock.calls[0][2]).toEqual({
      signal: controller.signal,
      taskType: LLM_TASK_TYPES.TOPIC_BOUNDARIES,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_progress',
      expect.objectContaining({ decided: 2, total: 2, gapStart: 1, gapEnd: 2, splitCount: 0 }),
      { verbose: true },
    );
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_decided',
      expect.objectContaining({
        gapCount: 2,
        splitCount: 0,
        requestCount: 1,
        shrinkCount: 0,
        retryCount: 0,
      }),
    );
  });

  it('logs a failure with its batch and status after exhausting retries', async () => {
    const error = Object.assign(new Error('HTTP 503'), { status: 503 });
    const decide = vi.fn().mockRejectedValue(error);
    const runtime = makeRuntime();
    const sleep = vi.fn(async () => undefined);

    await expect(
      decideTopicBoundaries({
        decide,
        sentences: makeSentences(3),
        runtime,
        sleep,
        random: () => 0.5,
      }),
    ).rejects.toBe(error);

    expect(decide).toHaveBeenCalledTimes(DECISION_MAX_ATTEMPTS);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([500, 1000]);
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_error',
      expect.objectContaining({ gapStart: 1, gapEnd: 2, status: 503, error: 'HTTP 503' }),
    );
  });

  it.each([
    ['a 503', Object.assign(new Error('loading model'), { status: 503 })],
    ['a 429', Object.assign(new Error('busy'), { status: 429, body: 'input too large' })],
    ['a 502', Object.assign(new Error('bad gateway'), { status: 502 })],
    ['a network TypeError', new TypeError('Failed to fetch')],
  ])('retries %s and then succeeds', async (_name, error) => {
    const controller = new AbortController();
    const runtime = makeRuntime({ signal: controller.signal });
    const succeed = makeDecide(() => 0.9);
    const decide = vi.fn().mockRejectedValueOnce(error).mockImplementation(succeed);
    const sleep = vi.fn(async () => undefined);

    const boundaries = await decideTopicBoundaries({
      decide,
      sentences: makeSentences(3),
      runtime,
      sleep,
      random: () => 0.5,
    });

    expect(boundaries.map((boundary) => boundary.split)).toEqual([true, true]);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500, controller.signal);
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_retry',
      expect.objectContaining({ gapStart: 1, gapEnd: 2, attempt: 1, delayMs: 500 }),
    );
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_decided',
      expect.objectContaining({ requestCount: 2, retryCount: 1, shrinkCount: 0 }),
    );
  });

  it('stops promptly when the run is aborted during the retry backoff', async () => {
    const controller = new AbortController();
    const runtime = makeRuntime({ signal: controller.signal });
    runtime.log.mockImplementation(async (name) => {
      if (name === 'topic_boundaries_retry') setTimeout(() => controller.abort(), 0);
    });
    const decide = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), { status: 503 }));
    const startedAt = Date.now();

    // The real abortable sleep would otherwise wait 500 ms.
    await expect(
      decideTopicBoundaries({ decide, sentences: makeSentences(3), runtime }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(Date.now() - startedAt).toBeLessThan(400);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_boundaries_error', expect.anything());
  });

  it('does not retry a request that failed because the run was cancelled', async () => {
    const controller = new AbortController();
    const runtime = makeRuntime({ signal: controller.signal });
    const decide = vi.fn(async () => {
      controller.abort();
      throw new TypeError('Failed to fetch');
    });
    const sleep = vi.fn(async () => undefined);

    await expect(
      decideTopicBoundaries({ decide, sentences: makeSentences(3), runtime, sleep }),
    ).rejects.toThrow('Failed to fetch');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('runs batches in parallel and assembles boundaries in gap order', async () => {
    // Units: [0], [1,2], [3], [4,5,6], [7]; asked gaps b2..b5 after sentences 0, 2, 3, 6.
    const sentences = [
      { text: 'A.' },
      { text: 'B1' },
      { text: 'B2.', continued: true },
      { text: 'C.' },
      { text: 'D1' },
      { text: 'D2', continued: true },
      { text: 'D3.', continued: true },
      { text: 'E.' },
    ];
    const probabilities = { b2: 0.1, b3: 0.9, b4: 0.2, b5: 0.8 };
    const parallelMap = vi.fn(async (items, _limit, fn) =>
      Promise.all(items.map((item, index) => fn(item, index))),
    );
    // Later batches answer first.
    const decide = vi.fn(async (_state, questions) => {
      const ids = Object.keys(questions);
      await new Promise((resolve) => setTimeout(resolve, 20 - Number(ids[0].slice(1)) * 4));
      return { answers: Object.fromEntries(ids.map((id) => [id, answer(probabilities[id])])) };
    });

    const boundaries = await decideTopicBoundaries({
      decide,
      sentences,
      batchSize: 1,
      parallelMap,
    });

    expect(parallelMap.mock.calls[0][0]).toHaveLength(4);
    expect(boundaries).toEqual([
      { after: 0, value: 0.1, split: false },
      { after: 1, value: null, split: false, withinSentence: true },
      { after: 2, value: 0.9, split: true },
      { after: 3, value: 0.2, split: false },
      { after: 4, value: null, split: false, withinSentence: true },
      { after: 5, value: null, split: false, withinSentence: true },
      { after: 6, value: 0.8, split: true },
    ]);
    expect(boundariesToRanges(8, boundaries)).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 6 },
      { start: 7, end: 7 },
    ]);
  });

  it('summarizes split and near-threshold counts', () => {
    expect(
      summarizeBoundaries(
        [
          { value: 0.9, split: true },
          { value: 0.55, split: true },
          { value: 0.1, split: false },
        ],
        0.5,
      ),
    ).toEqual({ gapCount: 3, splitCount: 2, nearThresholdCount: 1, meanSplitProbability: 0.517 });
    expect(summarizeBoundaries([], 0.5).meanSplitProbability).toBeNull();
  });

  it('halves only the oversized batch; other batches keep the configured size', async () => {
    let failed = false;
    const decide = vi.fn(async (_state, questions) => {
      if (!failed) {
        failed = true;
        throw oversizedError(413, 'request too many tokens');
      }
      return {
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, answer(0)])),
      };
    });
    const runtime = makeRuntime();

    const boundaries = await decideTopicBoundaries({
      decide,
      runtime,
      sentences: makeSentences(10),
      batchSize: 8,
      contextSentences: 2,
    });

    // The 1-gap second batch runs alongside; only the failed 8-gap batch splits.
    expect(decide.mock.calls.map((call) => questionIds(call).length)).toEqual([8, 1, 4, 4]);
    expect(decide.mock.calls.map((call) => questionIds(call)[0])).toEqual([
      'b2',
      'b10',
      'b2',
      'b6',
    ]);
    expect(boundaries.map((boundary) => boundary.after)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(runtime.log).toHaveBeenCalledWith('topic_boundaries_shrink', {
      gapStart: 1,
      gapEnd: 8,
      questionCount: 8,
      status: 413,
      batchSize: 4,
      contextSentences: 2,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_boundaries_decided',
      expect.objectContaining({ requestCount: 4, shrinkCount: 1 }),
    );
  });

  it.each([
    [400, 'The input is too large'],
    [413, 'context length exceeded'],
    [500, 'prompt exceeds the context window'],
    [400, 'context too long'],
  ])('recognizes oversized %i error "%s"', async (status, body) => {
    let failed = false;
    const decide = vi.fn(async (_state, questions) => {
      if (!failed) {
        failed = true;
        throw oversizedError(status, body);
      }
      return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, answer(0)])) };
    });

    await decideTopicBoundaries({ decide, sentences: makeSentences(4), batchSize: 3 });

    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('drops context after a single-gap batch is still too large, then rethrows', async () => {
    const error = oversizedError();
    const decide = vi.fn(async () => {
      throw error;
    });

    await expect(
      decideTopicBoundaries({
        decide,
        sentences: makeSentences(5),
        batchSize: 2,
        contextSentences: 2,
        parallelMap: sequentialMap,
      }),
    ).rejects.toBe(error);

    // 2 gaps -> 1 gap with context -> 1 gap without context -> rethrow.
    expect(decide.mock.calls.map((call) => [questionIds(call).length, contentIds(call)])).toEqual([
      [2, [1, 2, 3, 4, 5]],
      [1, [1, 2, 3, 4]],
      [1, [1, 2]],
    ]);
  });

  it('succeeds without context when only the context made the request too large', async () => {
    const decide = vi.fn(async (state, questions) => {
      if (state.content.length > 2) throw oversizedError();
      return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, answer(1)])) };
    });

    const boundaries = await decideTopicBoundaries({
      decide,
      sentences: makeSentences(3),
      batchSize: 1,
      contextSentences: 2,
    });

    expect(boundaries.map((boundary) => boundary.split)).toEqual([true, true]);
    expect(contentIds(decide.mock.calls.at(-1))).toEqual([2, 3]);
  });

  it.each([
    ['a non-size 400', Object.assign(new Error('bad'), { status: 400, body: 'invalid json' })],
    ['a 401', Object.assign(new Error('auth'), { status: 401, body: 'unauthorized' })],
    ['a plain error', new Error('Server returned invalid JSON')],
  ])('propagates %s without shrinking or retrying', async (_name, error) => {
    const decide = vi.fn(async () => {
      throw error;
    });
    noSleep.mockClear();

    await expect(
      decideTopicBoundaries({ decide, sentences: makeSentences(5), sleep: noSleep }),
    ).rejects.toBe(error);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing answer', { answers: {} }],
    ['no answers', {}],
    [
      'an unknown choice',
      { answers: { b2: { choice: 'maybe', probabilities: { split: 1, continue: 0 } } } },
    ],
    ['missing probabilities', { answers: { b2: { choice: 'split' } } }],
    [
      'probabilities that do not sum to one',
      { answers: { b2: { choice: 'split', probabilities: { split: 0.6, continue: 0.6 } } } },
    ],
    [
      'an out-of-range probability',
      { answers: { b2: { choice: 'split', probabilities: { split: 1.5, continue: -0.5 } } } },
    ],
    [
      'a non-numeric probability',
      { answers: { b2: { choice: 'split', probabilities: { split: '1', continue: 0 } } } },
    ],
  ])('rejects %s', async (_name, response) => {
    const decide = vi.fn(async () => response);

    await expect(decideTopicBoundaries({ decide, sentences: makeSentences(2) })).rejects.toThrow(
      'Invalid decision answer for boundary b2',
    );
  });

  it('accepts probabilities that sum to one within rounding tolerance', async () => {
    const decide = vi.fn(async () => ({
      answers: { b2: { choice: 'split', probabilities: { split: 0.7, continue: 0.3004 } } },
    }));
    const [boundary] = await decideTopicBoundaries({ decide, sentences: makeSentences(2) });
    expect(boundary).toEqual({ after: 0, value: 0.7, split: true });
  });

  it('rejects invalid batch and context sizes', async () => {
    const decide = makeDecide();
    const sentences = makeSentences(3);
    await expect(decideTopicBoundaries({ decide, sentences, batchSize: 0 })).rejects.toThrow(
      'batchSize must be >= 1',
    );
    await expect(decideTopicBoundaries({ decide, sentences, batchSize: 1.5 })).rejects.toThrow(
      'batchSize must be >= 1',
    );
    await expect(
      decideTopicBoundaries({ decide, sentences, contextSentences: -1 }),
    ).rejects.toThrow('contextSentences must be >= 0');
    expect(decide).not.toHaveBeenCalled();
  });
});

describe('boundariesToRanges', () => {
  const boundary = (after, split) => ({ after, value: split ? 1 : 0, split });

  it('returns no ranges for zero sentences and one range for one sentence', () => {
    expect(boundariesToRanges(0, [])).toEqual([]);
    expect(boundariesToRanges(1, [])).toEqual([{ start: 0, end: 0 }]);
  });

  it('builds inclusive zero-based ranges at split gaps', () => {
    expect(
      boundariesToRanges(5, [
        boundary(0, false),
        boundary(1, true),
        boundary(2, false),
        boundary(3, true),
      ]),
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 4 },
    ]);
  });

  it('returns a single range when nothing splits and singletons when everything does', () => {
    expect(boundariesToRanges(3, [boundary(0, false), boundary(1, false)])).toEqual([
      { start: 0, end: 2 },
    ]);
    expect(boundariesToRanges(3, [boundary(0, true), boundary(1, true)])).toEqual([
      { start: 0, end: 0 },
      { start: 1, end: 1 },
      { start: 2, end: 2 },
    ]);
  });

  it('rejects a wrong count, out-of-order, or misnumbered boundaries', () => {
    const message = 'One ordered boundary decision is required per adjacent sentence pair';
    expect(() => boundariesToRanges(3, [boundary(0, true)])).toThrow(message);
    expect(() => boundariesToRanges(2, [])).toThrow(message);
    expect(() => boundariesToRanges(1, [boundary(0, true)])).toThrow(message);
    expect(() => boundariesToRanges(3, [boundary(1, true), boundary(0, true)])).toThrow(message);
    expect(() => boundariesToRanges(3, [boundary(0, true), boundary(2, true)])).toThrow(message);
  });
});

describe('provider-aware decision sizing', () => {
  it('sizes multilingual requests before sending and retains all boundary decisions', async () => {
    const { estimateTokens } = await import('../llm/tokenEstimator.js');
    const decide = makeDecide(() => 0.9);
    const boundaries = await decideTopicBoundaries({
      decide,
      sentences: Array.from({ length: 10 }, () => ({ text: '漢'.repeat(2000) })),
      contextWindowTokens: 4096,
    });
    expect(boundaries).toHaveLength(9);
    expect(boundaries.every((boundary) => boundary.split)).toBe(true);
    for (const [state, questions] of decide.mock.calls) {
      expect(
        estimateTokens(JSON.stringify({ state, questions })) +
          256 +
          Object.keys(questions).length * 128,
      ).toBeLessThanOrEqual(4096);
    }
  });

  it('fails before transport when even the minimum question cannot fit', async () => {
    const decide = makeDecide();
    await expect(
      decideTopicBoundaries({ decide, sentences: makeSentences(2), contextWindowTokens: 10 }),
    ).rejects.toThrow('too small');
    expect(decide).not.toHaveBeenCalled();
  });
});
