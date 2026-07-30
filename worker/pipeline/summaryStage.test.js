import { describe, expect, it, vi } from 'vitest';
import { classifyLlmError, finalizeSummariesDisabled, runSummaries } from './summaryStage.js';
import { PIPELINE_STAGE, PIPELINE_STATUS } from '../../src/shared/runtime/contracts.js';

function makeRuntime() {
  return {
    signal: undefined,
    preferContentLanguage: false,
    update: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
  };
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
      summariesDisabled: true,
      progress: { stage: PIPELINE_STAGE.DONE, done: 2, total: 2 },
      summaryErrors: [],
      forceFinalize: false,
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
      progress: { stage: PIPELINE_STAGE.DONE, done: 1, total: 1 },
    });
  });

  it('uses the source text when the LLM returns NO_SUMMARY', async () => {
    const runtime = makeRuntime();
    const source = 'word '.repeat(70).trim();
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
      summaryErrors: [],
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
      sentenceTexts: ['word '.repeat(70).trim()],
      previousSummaries: {},
      callLLMWithRetry,
    });

    expect(lastUpdate(runtime)).toEqual({
      status: PIPELINE_STATUS.NEEDS_ATTENTION,
      topic_summary_index: {
        A: { runs: [{ sentences: [1], text: '' }], level: 0, source_sentences: [1] },
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
      progress: { stage: PIPELINE_STAGE.NEEDS_ATTENTION, done: 1, total: 1 },
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

  it('force-finalizes after a leaf failure and clears the error marker', async () => {
    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => {
      throw new Error('timed out');
    });

    await runSummaries({
      runtime,
      topics: [topic],
      sentenceTexts: ['word '.repeat(70).trim()],
      previousSummaries: {},
      forceFinalize: true,
      callLLMWithRetry,
    });

    expect(lastUpdate(runtime)).toMatchObject({
      status: PIPELINE_STATUS.DONE,
      topic_summaries: { A: { runs: [{ sentences: [1], text: '' }], source_sentences: [1] } },
      topic_summary_index: {
        A: { runs: [{ sentences: [1], text: '' }], level: 0, source_sentences: [1] },
      },
      summariesDisabled: false,
      summaryErrors: [],
      forceFinalize: false,
    });
    expect(runtime.log).not.toHaveBeenCalledWith(
      'topic_summaries_needs_attention',
      expect.anything(),
    );
  });
});
