import { describe, expect, it, vi } from 'vitest';
import {
  classifyLlmError,
  finalizeSummariesDisabled,
  isCancellationError,
  runSummaries,
} from './summaryStage.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';

function makeRuntime() {
  const topicSummaries = {};
  const sourceSummaryUnits = {};
  const runtime = {
    signal: undefined,
    preferContentLanguage: false,
    update: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
  runtime.checkpointTopicSummary = vi.fn(async (topicPath, summary) => {
    topicSummaries[topicPath] = summary;
    return runtime.update({ topic_summaries: { ...topicSummaries } });
  });
  runtime.checkpointSourceSummaryUnit = vi.fn(async (unit) => {
    sourceSummaryUnits[unit.unitId] = unit;
    return runtime.update({ source_summary_units: { ...sourceSummaryUnits } });
  });
  return runtime;
}

function lastUpdate(runtime, predicate = () => true) {
  return runtime.update.mock.calls
    .map(([patch]) => patch)
    .filter(predicate)
    .at(-1);
}

describe('classifyLlmError', () => {
  it.each([
    ['timed out', 'timeout'],
    ['HTTP 429 from provider', 'rate_limited'],
    ['no llm provider configured', 'no_provider'],
    ['401 invalid api key', 'auth'],
  ])('classifies %j as %s', (message, kind) => {
    expect(classifyLlmError(new Error(message))).toMatchObject({ kind });
  });

  it('truncates unrecognized error messages to 200 characters', () => {
    const result = classifyLlmError(new Error('x'.repeat(250)));

    expect(result).toEqual({ kind: 'error', message: `${'x'.repeat(200)}…` });
  });

  it('handles primitive and message-less errors', () => {
    expect(classifyLlmError('plain failure')).toEqual({
      kind: 'error',
      message: 'plain failure',
    });
    expect(classifyLlmError({})).toEqual({ kind: 'error', message: '[object Object]' });
  });
});

describe('isCancellationError', () => {
  it('recognizes AbortError by name', () => {
    const error = new Error('signal is aborted without reason');
    error.name = 'AbortError';
    expect(isCancellationError(error)).toBe(true);
  });

  it('does not mistake an unrelated error arriving after abort for cancellation', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isCancellationError(new Error('provider failed'), { signal: controller.signal })).toBe(
      false,
    );
  });

  it('recognizes the signal exact abort reason even without an AbortError name', () => {
    const reason = new Error('custom cancellation reason');
    const controller = new AbortController();
    controller.abort(reason);
    expect(isCancellationError(reason, { signal: controller.signal })).toBe(true);
  });

  it('does not flag a genuine provider error', () => {
    const runtime = { signal: { aborted: false } };
    expect(isCancellationError(new Error('401 invalid api key'), runtime)).toBe(false);
  });
});

describe('finalizeSummariesDisabled', () => {
  it('marks the run done without creating topic summaries', async () => {
    const runtime = makeRuntime();
    const topics = [
      { name: 'A', sentences: [1] },
      { name: 'B', sentences: [2] },
    ];

    await finalizeSummariesDisabled(runtime, topics);

    expect(lastUpdate(runtime)).toEqual({
      status: PIPELINE_STATUS.DONE,
      topic_summaries: {},
      topic_summary_index: {},
      source_summary_units: {},
      summariesDisabled: true,
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.DONE, done: 2, total: 2 },
      summaryErrors: [],
      forceFinalize: false,
      acceptedMergeFailurePaths: [],
    });
    expect(runtime.log).toHaveBeenNthCalledWith(1, 'summaries_disabled_skip', { topicCount: 2 });
    expect(runtime.log).toHaveBeenNthCalledWith(2, 'pipeline_done', {
      topicCount: 2,
      summaryNodeCount: 0,
    });
  });
});

describe('runSummaries', () => {
  const topic = { name: 'A', sentences: [1] };

  it('checkpoints each leaf independently and only writes the full map at finalization', async () => {
    const runtime = makeRuntime();
    runtime.checkpointTopicSummary = vi.fn(async () => undefined);
    runtime.checkpointSourceSummaryUnit = vi.fn(async () => undefined);

    await runSummaries({
      runtime,
      topics: [
        { name: 'A', sentences: [1] },
        { name: 'B', sentences: [2] },
        { name: 'C', sentences: [3] },
      ],
      sentenceTexts: ['short A', 'short B', 'short C'],
      previousSummaries: {},
      callLLMWithRetry: vi.fn(),
    });

    expect(runtime.checkpointTopicSummary).toHaveBeenCalledTimes(3);
    expect(runtime.update.mock.calls.filter(([patch]) => patch.topic_summaries)).toHaveLength(1);
    expect(runtime.update.mock.calls.filter(([patch]) => patch.source_summary_units)).toHaveLength(
      1,
    );
  });

  it('inlines short source runs without calling the LLM', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn();

    await runSummaries({
      runtime,
      topics: [topic],
      sentenceTexts: ['A short source sentence.'],
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).not.toHaveBeenCalled();
    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      topic_summaries: {
        A: {
          runs: [{ sentences: [1], text: 'A short source sentence.' }],
          source_sentences: [1],
        },
      },
      summariesDisabled: false,
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.DONE, done: 1, total: 1 },
    });
  });

  it.each([
    [150, 0],
    [151, 1],
  ])(
    'applies the parent source threshold when short leaves total %i words',
    async (wordCount, expectedCalls) => {
      const runtime = makeRuntime();
      // Every leaf stays inside the 70-word leaf inline budget, so only the
      // parent's aggregated source can cross the 150-word topic threshold.
      const leafWords = 34;
      const leafCount = Math.ceil(wordCount / leafWords);
      const sentenceTexts = Array.from({ length: leafCount }, (_, index) => {
        const words = index === leafCount - 1 ? wordCount - leafWords * (leafCount - 1) : leafWords;
        return `${String.fromCharCode(97 + index)} `.repeat(words).trim();
      });
      const callLLMWithRetry = vi.fn(async () => 'parent summary');

      await runSummaries({
        runtime,
        topics: sentenceTexts.map((_, index) => ({
          name: `A>${String.fromCharCode(88 + (index % 3))}${index}`,
          sentences: [index + 1],
        })),
        sentenceTexts,
        previousSummaries: {},
        callLLMWithRetry,
      });

      expect(callLLMWithRetry).toHaveBeenCalledTimes(expectedCalls);
      if (expectedCalls) {
        expect(callLLMWithRetry.mock.calls[0][0].taskType).toBe(
          LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE,
        );
      }
    },
  );

  it('uses the source text when the LLM returns NO_SUMMARY', async () => {
    const runtime = makeRuntime();
    const source = 'word '.repeat(120).trim();
    const callLLMWithRetry = vi.fn(async () => ' NO_SUMMARY. ');

    await runSummaries({
      runtime,
      topics: [topic],
      sentenceTexts: [source],
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: source }], source_sentences: [1] },
      },
      source_summary_units: {},
      summaryErrors: [],
    });
  });

  it('stops summarizing after a permanent provider failure and parks every unsummarized topic', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(220)}`.trim();
    const sentenceTexts = Array.from({ length: 8 }, (_, index) => long(`s${index + 1}`));
    const callLLMWithRetry = vi.fn(async () => {
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });

    await runSummaries({
      runtime,
      // Two topics of two runs each: four requests would be spent without the
      // permanent-failure stop, one with it.
      topics: [
        { name: 'A', sentences: [1, 2, 5, 6] },
        { name: 'B', sentences: [3, 4, 7, 8] },
      ],
      sentenceTexts,
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    const parked = lastUpdate(runtime);
    expect(parked).toMatchObject({ status: PIPELINE_STATUS.NEEDS_ATTENTION });
    // The topic that was never claimed parks alongside the one that failed,
    // rather than disappearing and letting the merge phase run without it.
    expect(parked.summaryErrors.map(({ topic }) => topic).sort()).toEqual(['A', 'B']);
  });

  it('stops chunking a single run after a permanent provider failure', async () => {
    const runtime = makeRuntime();
    // A tiny chunk budget puts one long run through the chunk burst inside
    // sourceSummarizer, which is the other queue a doomed warmup can fan out.
    runtime.maxTextChunkChars = 200;
    const sentenceTexts = Array.from({ length: 6 }, (_, index) =>
      `s${index + 1} ${'word '.repeat(120)}`.trim(),
    );
    const callLLMWithRetry = vi.fn(async () => {
      throw Object.assign(new Error('invalid api key'), { status: 401 });
    });

    await runSummaries({
      runtime,
      topics: [{ name: 'A', sentences: [1, 2, 3, 4, 5, 6] }],
      sentenceTexts,
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(lastUpdate(runtime)).toMatchObject({ status: PIPELINE_STATUS.NEEDS_ATTENTION });
  });

  it('persists completed runs before a later run resolves', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [
      long('first-1'),
      long('first-2'),
      'gap.',
      'gap.',
      long('second-5'),
      long('second-6'),
    ];
    let resolveSecond;
    const secondPending = new Promise((resolve) => {
      resolveSecond = resolve;
    });
    let calls = 0;
    const callLLMWithRetry = vi.fn(async () => {
      calls++;
      if (calls === 1) return 'first run summary';
      return secondPending;
    });

    const running = runSummaries({
      runtime,
      topics: [{ name: 'A', sentences: [1, 2, 5, 6] }],
      sentenceTexts,
      previousSummaries: {},
      callLLMWithRetry,
    });

    await vi.waitFor(() => {
      const checkpoint = runtime.update.mock.calls
        .map(([patch]) => patch)
        .find((patch) => patch.topic_summaries?.A?.runs?.[0]?.text === 'first run summary');
      expect(checkpoint).toBeDefined();
      expect(checkpoint.topic_summaries.A.runs[1]).toMatchObject({
        sentences: [5, 6],
        error: true,
      });
    });

    resolveSecond('second run summary');
    await running;
  });

  it('retries only the failed run in a partially completed topic', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const firstSource = `${long('first-1')} ${long('first-2')}`;
    const secondSource = `${long('second-5')} ${long('second-6')}`;
    const callLLMWithRetry = vi.fn(async () => 'recovered second run');

    await runSummaries({
      runtime,
      topics: [{ name: 'A', sentences: [1, 2, 5, 6] }],
      sentenceTexts: [
        long('first-1'),
        long('first-2'),
        'gap.',
        'gap.',
        long('second-5'),
        long('second-6'),
      ],
      previousSummaries: {
        A: {
          runs: [
            { sentences: [1, 2], text: 'existing first run' },
            { sentences: [5, 6], text: '', error: true, error_kind: 'timeout' },
          ],
          source_sentences: [1, 2, 5, 6],
          error: true,
        },
      },
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).toContain(secondSource);
    expect(callLLMWithRetry.mock.calls[0][0].prompt).not.toContain(firstSource);
    expect(lastUpdate(runtime).topic_summaries.A.runs).toEqual([
      { sentences: [1, 2], text: 'existing first run' },
      { sentences: [5, 6], text: 'recovered second run' },
    ]);
  });

  it('reuses successful merge paths and retries only a failed parent path', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [
      long('tech-a1'),
      long('tech-a2'),
      long('tech-b1'),
      long('tech-b2'),
      long('other-a1'),
      long('other-a2'),
      long('other-b1'),
      long('other-b2'),
    ];
    const callLLMWithRetry = vi.fn(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE ? 'retried other parent' : 'leaf',
    );

    await runSummaries({
      runtime,
      topics: [
        { name: 'Tech>A', sentences: [1, 2] },
        { name: 'Tech>B', sentences: [3, 4] },
        { name: 'Other>A', sentences: [5, 6] },
        { name: 'Other>B', sentences: [7, 8] },
      ],
      sentenceTexts,
      previousSummaries: {
        'Tech>A': { runs: [{ sentences: [1, 2], text: 'tech leaf a' }] },
        'Tech>B': { runs: [{ sentences: [3, 4], text: 'tech leaf b' }] },
        'Other>A': { runs: [{ sentences: [5, 6], text: 'other leaf a' }] },
        'Other>B': { runs: [{ sentences: [7, 8], text: 'other leaf b' }] },
      },
      previousSummaryIndex: {
        Tech: {
          runs: [{ sentences: [1, 2, 3, 4], text: 'existing tech parent' }],
          source_sentences: [1, 2, 3, 4],
          level: 0,
        },
        Other: {
          runs: [{ sentences: [5, 6, 7, 8], text: '' }],
          source_sentences: [5, 6, 7, 8],
          level: 0,
          error: true,
        },
        'Tech>A': { runs: [{ sentences: [1, 2], text: 'tech leaf a' }], source_sentences: [1, 2] },
        'Tech>B': { runs: [{ sentences: [3, 4], text: 'tech leaf b' }], source_sentences: [3, 4] },
        'Other>A': {
          runs: [{ sentences: [5, 6], text: 'other leaf a' }],
          source_sentences: [5, 6],
        },
        'Other>B': {
          runs: [{ sentences: [7, 8], text: 'other leaf b' }],
          source_sentences: [7, 8],
        },
      },
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(lastUpdate(runtime).topic_summary_index.Tech.runs).toEqual([
      { sentences: [1, 2, 3, 4], text: 'existing tech parent' },
    ]);
    expect(lastUpdate(runtime).topic_summary_index.Other.runs).toEqual([
      { sentences: [5, 6, 7, 8], text: 'retried other parent' },
    ]);
  });

  it('reuses persisted oversized merge chunks on a normal retry and then clears them on success', async () => {
    const long = (marker) => `${marker} ${'x'.repeat(30000)}`;
    const topics = [
      { name: 'Tech>AI', sentences: [1, 2] },
      { name: 'Tech>Hardware', sentences: [3, 4] },
    ];
    const sentenceTexts = [long('a1'), long('a2'), long('b1'), long('b2')];
    const previousSummaries = {
      'Tech>AI': { runs: [{ sentences: [1, 2], text: 'AI summary.' }], source_sentences: [1, 2] },
      'Tech>Hardware': {
        runs: [{ sentences: [3, 4], text: 'Hardware summary.' }],
        source_sentences: [3, 4],
      },
    };

    const firstRuntime = makeRuntime();
    const firstCall = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('chunk three')
      .mockResolvedValueOnce('chunk four')
      .mockRejectedValueOnce(new Error('timed out'));

    await runSummaries({
      runtime: firstRuntime,
      topics,
      sentenceTexts,
      previousSummaries,
      contentRevision: 'rev-1',
      callLLMWithRetry: firstCall,
    });

    const parked = lastUpdate(
      firstRuntime,
      (patch) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION,
    );
    expect(parked.summaryErrors).toEqual([
      expect.objectContaining({ topic: 'Tech', error_kind: 'timeout' }),
    ]);
    const persistedSourceUnitWrites = firstRuntime.update.mock.calls
      .map(([patch]) => patch.source_summary_units)
      .filter(Boolean);
    expect(persistedSourceUnitWrites).toHaveLength(4);
    const persistedUnits = persistedSourceUnitWrites.at(-1);
    expect(Object.keys(persistedUnits)).toHaveLength(4);

    const secondRuntime = makeRuntime();
    const secondCall = vi.fn(async () => 'retried merged parent');

    await runSummaries({
      runtime: secondRuntime,
      topics,
      sentenceTexts,
      previousSummaries,
      previousSummaryIndex: parked.topic_summary_index,
      previousSourceSummaryUnits: persistedUnits,
      contentRevision: 'rev-1',
      callLLMWithRetry: secondCall,
    });

    expect(secondCall).toHaveBeenCalledTimes(1);
    expect(secondCall).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE }),
      expect.any(Number),
    );
    expect(lastUpdate(secondRuntime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      source_summary_units: {},
      topic_summary_index: {
        Tech: {
          runs: [{ sentences: [1, 2, 3, 4], text: 'retried merged parent' }],
        },
      },
    });
  });

  it('parks the run for review when a leaf summary fails', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => {
      throw new Error('401 invalid api key');
    });

    await runSummaries({
      runtime,
      topics: [topic],
      sentenceTexts: ['word '.repeat(120).trim()],
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(lastUpdate(runtime)).toEqual({
      status: PIPELINE_STATUS.NEEDS_ATTENTION,
      topic_summary_index: {
        A: {
          runs: [{ sentences: [1], text: '', error: true }],
          level: 0,
          source_sentences: [1],
        },
      },
      summaryErrors: [
        {
          topic: 'A',
          error_kind: 'auth',
          error_message: 'The model provider rejected the request (check your API key).',
          error_detail: '401 invalid api key',
        },
      ],
      forceFinalize: false,
      summariesIncomplete: false,
      progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done: 0, total: 1 },
    });
    expect(runtime.log).toHaveBeenCalledWith('topic_summaries_needs_attention', {
      phase: 'leaf',
      errorCount: 1,
      topics: ['A'],
    });
    expect(runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.DONE)).toBe(
      false,
    );
  });

  it('fails normally when persisting a generated leaf cache unit fails', async () => {
    const storageError = new Error('storage quota exceeded');
    const runtime = makeRuntime();
    runtime.update.mockImplementation(async (patch) => {
      if (patch.source_summary_units) throw storageError;
    });
    const callLLMWithRetry = vi.fn(async () => 'Generated summary.');

    await expect(
      runSummaries({
        runtime,
        topics: [topic],
        sentenceTexts: ['word '.repeat(120).trim()],
        previousSummaries: {},
        contentRevision: 'rev-1',
        callLLMWithRetry,
      }),
    ).rejects.toBe(storageError);

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
    expect(runtime.log).not.toHaveBeenCalledWith('topic_summary_llm_error', expect.anything());
  });

  it('retries only the failed chunk of an oversized leaf summary', async () => {
    const sentenceTexts = [
      `one ${'x'.repeat(30000)}`,
      `two ${'x'.repeat(30000)}`,
      `three ${'x'.repeat(30000)}`,
    ];
    const firstRuntime = makeRuntime();
    const firstCall = vi
      .fn()
      .mockResolvedValueOnce('chunk one')
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce('chunk three');

    await runSummaries({
      runtime: firstRuntime,
      topics: [{ name: 'A', sentences: [1, 2, 3] }],
      sentenceTexts,
      previousSummaries: {},
      contentRevision: 'rev-leaf',
      callLLMWithRetry: firstCall,
    });

    expect(
      lastUpdate(firstRuntime, (patch) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBeDefined();
    const failedLeafSummaries = lastUpdate(
      firstRuntime,
      (patch) => patch.topic_summaries,
    ).topic_summaries;
    const persistedUnits = firstRuntime.update.mock.calls
      .map(([patch]) => patch.source_summary_units)
      .filter(Boolean)
      .at(-1);
    expect(firstCall).toHaveBeenCalledTimes(3);
    expect(Object.keys(persistedUnits)).toHaveLength(2);

    const secondRuntime = makeRuntime();
    const secondCall = vi
      .fn()
      .mockResolvedValueOnce('chunk two')
      .mockResolvedValueOnce('merged leaf');
    await runSummaries({
      runtime: secondRuntime,
      topics: [{ name: 'A', sentences: [1, 2, 3] }],
      sentenceTexts,
      previousSummaries: failedLeafSummaries,
      previousSourceSummaryUnits: persistedUnits,
      contentRevision: 'rev-leaf',
      callLLMWithRetry: secondCall,
    });

    expect(secondCall).toHaveBeenCalledTimes(2);
    expect(secondCall.mock.calls[0][0].taskType).toBe(LLM_TASK_TYPES.ARTICLE_SUMMARY);
    expect(secondCall.mock.calls[1][0].taskType).toBe(LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE);
    expect(lastUpdate(secondRuntime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      topic_summaries: {
        A: { runs: [{ sentences: [1, 2, 3], text: 'merged leaf' }] },
      },
    });
  });

  it('propagates a genuine AbortError unchanged (same object identity)', async () => {
    const runtime = makeRuntime();
    runtime.signal = { aborted: true };
    const abortError = new Error('signal is aborted without reason');
    abortError.name = 'AbortError';
    const callLLMWithRetry = vi.fn(async () => {
      throw abortError;
    });

    await expect(
      runSummaries({
        runtime,
        topics: [topic],
        sentenceTexts: ['word '.repeat(120).trim()],
        previousSummaries: {},
        callLLMWithRetry,
      }),
    ).rejects.toBe(abortError);

    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
  });

  it('propagates the original non-cancellation error that arrives after abort', async () => {
    const runtime = makeRuntime();
    runtime.signal = { aborted: true };
    const raceError = new TypeError('Cannot read properties of undefined');
    const callLLMWithRetry = vi.fn(async () => {
      throw raceError;
    });

    await expect(
      runSummaries({
        runtime,
        topics: [topic],
        sentenceTexts: ['word '.repeat(120).trim()],
        previousSummaries: {},
        callLLMWithRetry,
      }),
    ).rejects.toBe(raceError);

    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
  });

  it('propagates an unrelated merge failure that arrives after abort', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    const raceError = new TypeError('transport closed while aborting');
    const callLLMWithRetry = vi.fn(async () => {
      controller.abort();
      throw raceError;
    });

    await expect(
      runSummaries({
        runtime,
        topics: [
          { name: 'A>x', sentences: [1] },
          { name: 'A>y', sentences: [2] },
        ],
        sentenceTexts: ['x '.repeat(110).trim(), 'y '.repeat(110).trim()],
        previousSummaries: {
          'A>x': { runs: [{ sentences: [1], text: 'X' }], source_sentences: [1] },
          'A>y': { runs: [{ sentences: [2], text: 'Y' }], source_sentences: [2] },
        },
        callLLMWithRetry,
      }),
    ).rejects.toBe(raceError);
    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_tree_merge_error', expect.anything());
  });

  // The merge stage below reuses both leaves from the checkpoint, so the only
  // LLM request left is the ancestor's source summary.
  const mergeOnlyRun = (runtime, callLLMWithRetry) =>
    runSummaries({
      runtime,
      topics: [
        { name: 'A>x', sentences: [1] },
        { name: 'A>y', sentences: [2] },
      ],
      sentenceTexts: ['x '.repeat(110).trim(), 'y '.repeat(110).trim()],
      previousSummaries: {
        'A>x': { runs: [{ sentences: [1], text: 'X' }], source_sentences: [1] },
        'A>y': { runs: [{ sentences: [2], text: 'Y' }], source_sentences: [2] },
      },
      callLLMWithRetry,
    });

  it('parks the run for review when a merge summary fails at the provider', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => {
      throw new Error('timed out');
    });

    await mergeOnlyRun(runtime, callLLMWithRetry);

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(runtime.update).toHaveBeenCalledWith({
      progress: { stage: PIPELINE_STAGE.MERGING_SUMMARIES, done: 0, total: 0 },
    });
    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.NEEDS_ATTENTION,
      summaryErrors: [
        {
          topic: 'A',
          error_kind: 'timeout',
          error_message: 'The model did not respond in time.',
          error_detail: 'Error: timed out',
        },
      ],
      forceFinalize: false,
      progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done: 0, total: 0 },
    });
    expect(runtime.log).toHaveBeenCalledWith('topic_tree_merge_error', {
      path: 'A',
      error_kind: 'timeout',
      error: 'The model did not respond in time.',
    });
    expect(runtime.log).toHaveBeenCalledWith('topic_summaries_needs_attention', {
      phase: 'merge',
      errorCount: 1,
      topics: ['A'],
    });
  });

  it('rejects instead of parking when our own merge parsing code throws', async () => {
    // Same policy as the leaf path: a TypeError raised while parsing the merge
    // response is a deterministic bug, so it must not travel through
    // classifyLlmError and park the node behind a Retry that cannot succeed.
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => ({
      toString() {
        throw new TypeError('not a summary response');
      },
    }));

    await expect(mergeOnlyRun(runtime, callLLMWithRetry)).rejects.toThrow(TypeError);

    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_tree_merge_error', expect.anything());
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
  });

  it('rejects instead of parking when a merge dependency throws a primitive', async () => {
    // A non-object throw cannot carry the provider marker; it must still be
    // treated as our own bug rather than silently parked.
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => ({
      toString() {
        throw 'prompt template missing';
      },
    }));

    await expect(mergeOnlyRun(runtime, callLLMWithRetry)).rejects.toBe('prompt template missing');

    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_tree_merge_error', expect.anything());
  });

  it('propagates a merge-stage cancellation as an AbortError without parking', async () => {
    const runtime = makeRuntime();
    const controller = new AbortController();
    runtime.signal = controller.signal;
    const abortError = new Error('signal is aborted without reason');
    abortError.name = 'AbortError';
    const callLLMWithRetry = vi.fn(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(mergeOnlyRun(runtime, callLLMWithRetry)).rejects.toBe(abortError);

    expect(
      runtime.update.mock.calls.some(([patch]) => patch.status === PIPELINE_STATUS.NEEDS_ATTENTION),
    ).toBe(false);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_tree_merge_error', expect.anything());
  });

  it('parks a new leaf failure during a force-finalizing resume', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => {
      throw new Error('timed out');
    });

    await runSummaries({
      runtime,
      topics: [topic],
      sentenceTexts: ['word '.repeat(120).trim()],
      previousSummaries: {},
      forceFinalize: true,
      callLLMWithRetry,
    });

    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.NEEDS_ATTENTION,
      summaryErrors: [{ topic: 'A', error_kind: 'timeout' }],
      forceFinalize: false,
    });
    expect(runtime.log).toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.objectContaining({ phase: 'leaf', topics: ['A'] }),
    );
  });

  it('force-finalizes a leaf skip while preserving unaffected ancestor work', async () => {
    // All leaves are already checkpointed when review opens. The user accepted
    // `A>z`'s failure; its source stays empty while the successful x/y branch
    // still contributes a freshly generated ancestor summary.
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [
      long('s1'),
      long('s2'),
      long('s3'),
      long('s4'),
      long('gap5'),
      long('gap6'),
      long('gap7'),
      long('gap8'),
      long('gap9'),
      long('zzz10'),
      long('zzz11'),
    ];
    const callLLMWithRetry = vi.fn(async () => 'Unaffected A summary.');

    await runSummaries({
      runtime,
      topics: [
        { name: 'A>x', sentences: [1, 2] },
        { name: 'A>y', sentences: [3, 4] },
        { name: 'A>z', sentences: [10, 11] },
      ],
      sentenceTexts,
      previousSummaries: {
        'A>x': { runs: [{ sentences: [1, 2], text: 'X' }], source_sentences: [1, 2] },
        'A>y': { runs: [{ sentences: [3, 4], text: 'Y' }], source_sentences: [3, 4] },
        'A>z': {
          runs: [{ sentences: [10, 11], text: '', acceptedFailure: true }],
          source_sentences: [10, 11],
        },
      },
      forceFinalize: true,
      callLLMWithRetry,
    });

    const patch = lastUpdate(runtime);
    expect(patch).toMatchObject({ status: PIPELINE_STATUS.DONE, forceFinalize: false });
    expect(patch.topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2, 3, 4], text: 'Unaffected A summary.' },
      { sentences: [10, 11], text: '' },
    ]);
    expect(patch.topic_summary_index['A>x'].runs).toEqual([{ sentences: [1, 2], text: 'X' }]);
    expect(patch.topic_summary_index['A>y'].runs).toEqual([{ sentences: [3, 4], text: 'Y' }]);
    expect(patch.topic_summary_index['A>z'].runs).toEqual([{ sentences: [10, 11], text: '' }]);
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(runtime.log).not.toHaveBeenCalledWith('topic_tree_merge_error', expect.anything());
  });

  it('omits an accepted leaf source while retaining adjacent ancestor-owned content', async () => {
    const runtime = makeRuntime();
    const ownSource = `ancestor ${'word '.repeat(220)}`.trim();
    const failedSource = `failed-leaf ${'word '.repeat(120)}`.trim();
    const callLLMWithRetry = vi.fn(async () => 'Ancestor-only summary.');

    await runSummaries({
      runtime,
      topics: [
        { name: 'A', sentences: [1] },
        { name: 'A>failed', sentences: [2] },
      ],
      sentenceTexts: [ownSource, failedSource],
      previousSummaries: {
        A: {
          runs: [{ sentences: [1], text: 'Existing ancestor leaf summary.' }],
          source_sentences: [1],
        },
        'A>failed': {
          runs: [{ sentences: [2], text: '', acceptedFailure: true }],
          source_sentences: [2],
        },
      },
      forceFinalize: true,
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    const prompt = callLLMWithRetry.mock.calls[0][0].prompt;
    expect(prompt).toContain(ownSource);
    expect(prompt).not.toContain(failedSource);
    expect(lastUpdate(runtime).topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2], text: 'Ancestor-only summary.' },
    ]);
    expect(lastUpdate(runtime).topic_summary_index['A>failed'].runs).toEqual([
      { sentences: [2], text: '' },
    ]);
  });

  it('scopes and stamps a reused acceptedFailure leaf on the real skip resume', async () => {
    // The actual "skip" path: the handler already swapped the leaf's error flags
    // for `acceptedFailure`, so the resumed run REUSES the leaf (no re-query) and
    // must still recognize it as failed through planSummaryWork's narrowed shape.
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [
      long('s1'),
      long('s2'),
      long('s3'),
      long('s4'),
      long('gap5'),
      long('gap6'),
      long('gap7'),
      long('gap8'),
      long('gap9'),
      long('zzz10'),
      long('zzz11'),
    ];
    const callLLMWithRetry = vi.fn(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.ARTICLE_SUMMARY ? 'LEAF' : 'PARENT',
    );

    await runSummaries({
      runtime,
      topics: [
        { name: 'A>x', sentences: [1, 2] },
        { name: 'A>y', sentences: [3, 4] },
        { name: 'A>z', sentences: [10, 11] },
      ],
      sentenceTexts,
      previousSummaries: {
        'A>x': { runs: [{ sentences: [1, 2], text: 'LEAF' }], source_sentences: [1, 2] },
        'A>y': { runs: [{ sentences: [3, 4], text: 'LEAF' }], source_sentences: [3, 4] },
        'A>z': {
          runs: [{ sentences: [10, 11], text: '', acceptedFailure: true }],
          source_sentences: [10, 11],
        },
      },
      forceFinalize: true,
      callLLMWithRetry,
    });

    const patch = lastUpdate(runtime);
    expect(patch.topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2, 3, 4], text: 'PARENT' },
      { sentences: [10, 11], text: '' },
    ]);
    // The accepted failure is finalized, not persisted as a transient marker.
    expect(patch.topic_summaries['A>z']).toEqual({
      runs: [{ sentences: [10, 11], text: '', forcedEmpty: true }],
      source_sentences: [10, 11],
      forcedEmpty: true,
    });
    expect(patch.topic_summaries['A>x'].forcedEmpty).toBeUndefined();
    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
  });

  it('finalizes an accepted merge failure without repeating its source-summary request', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [
      long('a1'),
      long('a2'),
      long('b1'),
      long('b2'),
      long('c1'),
      long('c2'),
      long('d1'),
      long('d2'),
    ];
    const callLLMWithRetry = vi.fn(async () => 'should not be called');

    await runSummaries({
      runtime,
      topics: [
        { name: 'Tech>AI', sentences: [1, 2] },
        { name: 'Tech>Hardware', sentences: [3, 4] },
        { name: 'Other>One', sentences: [5, 6] },
        { name: 'Other>Two', sentences: [7, 8] },
      ],
      sentenceTexts,
      previousSummaries: {
        'Tech>AI': { runs: [{ sentences: [1, 2], text: 'AI summary.' }] },
        'Tech>Hardware': { runs: [{ sentences: [3, 4], text: 'Hardware summary.' }] },
        'Other>One': { runs: [{ sentences: [5, 6], text: 'One summary.' }] },
        'Other>Two': { runs: [{ sentences: [7, 8], text: 'Two summary.' }] },
      },
      previousSummaryIndex: {
        Tech: {
          runs: [{ sentences: [1, 2, 3, 4], text: '' }],
          level: 0,
          source_sentences: [1, 2, 3, 4],
        },
        'Tech>AI': {
          runs: [{ sentences: [1, 2], text: 'AI summary.' }],
          level: 1,
          source_sentences: [1, 2],
        },
        'Tech>Hardware': {
          runs: [{ sentences: [3, 4], text: 'Hardware summary.' }],
          level: 1,
          source_sentences: [3, 4],
        },
        Other: {
          runs: [{ sentences: [5, 6, 7, 8], text: 'Existing successful merge.' }],
          level: 0,
          source_sentences: [5, 6, 7, 8],
        },
        'Other>One': {
          runs: [{ sentences: [5, 6], text: 'One summary.' }],
          level: 1,
          source_sentences: [5, 6],
        },
        'Other>Two': {
          runs: [{ sentences: [7, 8], text: 'Two summary.' }],
          level: 1,
          source_sentences: [7, 8],
        },
      },
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Tech'],
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).not.toHaveBeenCalled();
    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      summariesDisabled: false,
      summariesIncomplete: true,
      topic_summary_index: {
        Tech: { runs: [{ sentences: [1, 2, 3, 4], text: '' }] },
        Other: { runs: [{ sentences: [5, 6, 7, 8], text: 'Existing successful merge.' }] },
      },
      acceptedMergeFailurePaths: [],
    });
  });

  it('refuses a parked merge index whose internal node runs do not fit the tree', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [long('a1'), long('a2'), long('b1'), long('b2')];
    const callLLMWithRetry = vi.fn(async () => 'Rebuilt merge.');

    await runSummaries({
      runtime,
      topics: [
        { name: 'Accepted>One', sentences: [1] },
        { name: 'Accepted>Two', sentences: [2] },
        { name: 'Other>One', sentences: [3] },
        { name: 'Other>Two', sentences: [4] },
      ],
      sentenceTexts,
      previousSummaries: {
        'Accepted>One': { runs: [{ sentences: [1], text: 'A1' }] },
        'Accepted>Two': { runs: [{ sentences: [2], text: 'A2' }] },
        'Other>One': { runs: [{ sentences: [3], text: 'B1' }] },
        'Other>Two': { runs: [{ sentences: [4], text: 'B2' }] },
      },
      previousSummaryIndex: {
        Accepted: { runs: [{ sentences: [1, 2], text: '' }], level: 0, source_sentences: [1, 2] },
        'Accepted>One': { runs: [{ sentences: [1], text: 'A1' }], level: 1, source_sentences: [1] },
        'Accepted>Two': { runs: [{ sentences: [2], text: 'A2' }], level: 1, source_sentences: [2] },
        // Corrupt internal node: it claims the right source, but its runs are
        // split and located as if they belonged to the other branch. Only the
        // leaves used to be checked against the current tree, so this branch
        // could be adopted whole — the rails place each card by its run's
        // sentence ids, so it would surface as the wrong text in the right
        // place rather than as missing text.
        Other: {
          runs: [
            { sentences: [1], text: 'Belongs to the Accepted branch.' },
            { sentences: [4], text: 'Other tail.' },
          ],
          level: 0,
          source_sentences: [3, 4],
        },
        'Other>One': { runs: [{ sentences: [3], text: 'B1' }], level: 1, source_sentences: [3] },
        'Other>Two': { runs: [{ sentences: [4], text: 'B2' }], level: 1, source_sentences: [4] },
      },
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Accepted'],
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(lastUpdate(runtime)).toMatchObject({ status: PIPELINE_STATUS.DONE });
    expect(lastUpdate(runtime).topic_summary_index.Other.runs).toEqual([
      { sentences: [3, 4], text: 'Rebuilt merge.' },
    ]);
    expect(lastUpdate(runtime).topic_summary_index.Accepted.runs).toEqual([
      { sentences: [1, 2], text: '' },
    ]);
  });

  it('rebuilds an unusable merge checkpoint without emptying unrelated branches', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(120)}`.trim();
    const sentenceTexts = [long('a1'), long('a2'), long('b1'), long('b2')];
    const callLLMWithRetry = vi.fn(async () => 'Retried other merge.');

    await runSummaries({
      runtime,
      topics: [
        { name: 'Accepted>One', sentences: [1] },
        { name: 'Accepted>Two', sentences: [2] },
        { name: 'Other>One', sentences: [3] },
        { name: 'Other>Two', sentences: [4] },
      ],
      sentenceTexts,
      previousSummaries: {
        'Accepted>One': { runs: [{ sentences: [1], text: 'A1' }] },
        'Accepted>Two': { runs: [{ sentences: [2], text: 'A2' }] },
        'Other>One': { runs: [{ sentences: [3], text: 'B1' }] },
        'Other>Two': { runs: [{ sentences: [4], text: 'B2' }] },
      },
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Accepted'],
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(callLLMWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ taskType: LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE }),
      expect.any(Number),
    );
    expect(lastUpdate(runtime)).toMatchObject({ status: PIPELINE_STATUS.DONE });
    expect(lastUpdate(runtime).topic_summary_index.Accepted.runs).toEqual([
      { sentences: [1, 2], text: '' },
    ]);
    expect(lastUpdate(runtime).topic_summary_index.Other.runs).toEqual([
      { sentences: [3, 4], text: 'Retried other merge.' },
    ]);
  });

  it('keeps force-finalize path-scoped when Retry carries an accepted leaf marker', async () => {
    const runtime = makeRuntime();
    const long = (marker) => `${marker} ${'word '.repeat(220)}`.trim();
    const sentenceTexts = [long('a1'), long('a2'), long('b1'), long('b2')];
    const callLLMWithRetry = vi.fn(async ({ prompt }) =>
      prompt.includes('a2') ? 'Recovered good sibling.' : 'Recovered unrelated branch.',
    );

    await runSummaries({
      runtime,
      topics: [
        { name: 'Accepted>Failed', sentences: [1] },
        { name: 'Accepted>Good', sentences: [2] },
        { name: 'Retried>One', sentences: [3] },
        { name: 'Retried>Two', sentences: [4] },
      ],
      sentenceTexts,
      previousSummaries: {
        'Accepted>Failed': {
          runs: [{ sentences: [1], text: '', acceptedFailure: true }],
          source_sentences: [1],
        },
        'Accepted>Good': { runs: [{ sentences: [2], text: 'Good' }], source_sentences: [2] },
        'Retried>One': { runs: [{ sentences: [3], text: 'One' }], source_sentences: [3] },
        'Retried>Two': { runs: [{ sentences: [4], text: 'Two' }], source_sentences: [4] },
      },
      // This is the defensive chained-review state produced when Retry keeps
      // an accepted marker from an earlier decision.
      forceFinalize: true,
      callLLMWithRetry,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
    expect(lastUpdate(runtime).topic_summary_index.Accepted.runs).toEqual([
      { sentences: [1, 2], text: 'Recovered good sibling.' },
    ]);
    expect(lastUpdate(runtime).topic_summary_index.Retried.runs).toEqual([
      { sentences: [3, 4], text: 'Recovered unrelated branch.' },
    ]);
    expect(lastUpdate(runtime).topic_summaries['Accepted>Failed'].forcedEmpty).toBe(true);
  });

  it('rejects instead of parking when our own parsing code throws', async () => {
    // A TypeError from parseSummaryResult is a deterministic bug, not a
    // retryable provider failure: parking it would offer a Retry button that
    // can never succeed.
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => ({
      toString() {
        throw new TypeError('not a summary response');
      },
    }));

    await expect(
      runSummaries({
        runtime,
        topics: [topic],
        sentenceTexts: ['word '.repeat(120).trim()],
        previousSummaries: {},
        callLLMWithRetry,
      }),
    ).rejects.toThrow(TypeError);

    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summary_llm_error',
      expect.objectContaining({ error_kind: 'error' }),
    );
  });

  it('marks an accepted failure forcedEmpty so a later resume retries it', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn();

    await runSummaries({
      runtime,
      topics: [topic, { name: 'B', sentences: [2] }],
      sentenceTexts: ['word '.repeat(120).trim(), 'A short second sentence.'],
      previousSummaries: {
        A: {
          runs: [{ sentences: [1], text: '', acceptedFailure: true }],
          source_sentences: [1],
        },
      },
      forceFinalize: true,
      callLLMWithRetry,
    });

    const { topic_summaries, summariesDisabled, summariesIncomplete } = lastUpdate(runtime);
    expect(topic_summaries.A).toEqual({
      runs: [{ sentences: [1], text: '', forcedEmpty: true }],
      source_sentences: [1],
      forcedEmpty: true,
    });
    // The successful topic stays a plain summary: no marker, so it is reused.
    expect(topic_summaries.B).toEqual({
      runs: [{ sentences: [2], text: 'A short second sentence.' }],
      source_sentences: [2],
    });
    expect(summariesDisabled).toBe(false);
    expect(summariesIncomplete).toBe(true);
  });
});
