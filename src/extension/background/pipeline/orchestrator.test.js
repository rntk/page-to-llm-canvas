import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPipelineRunner } from './orchestrator.js';
import { createPipelineRuntime } from './pipelineRuntime.js';
import * as storage from '../../../core/storage/storage.js';
import * as capturedText from '../../../core/pipeline/capturedText.js';
import * as sentenceSplitter from '../../../core/pipeline/sentenceSplitter.js';
import * as llm from '../../../core/llm/llm.js';
import { getActiveProvider } from '../../../core/llm/providers.js';
import { LLM_TASK_TYPES, wrapCallLLMWithRetry } from '../../../core/metrics/llm.js';
import { getStoredVerboseLogs } from '../../../shared/runtime/verboseLogSettings.js';
import { getStoredPreferContentLanguage } from '../../../core/settings/language.js';
import {
  getStoredMaxParallelLlmRequests,
  normalizeMaxParallelLlmRequests,
} from '../../../core/settings/llmConcurrency.js';

const pipelineLimiter = vi.hoisted(() => ({
  run: vi.fn((fn) => fn()),
  setLimit: vi.fn(),
}));

vi.mock('../../../core/storage/storage.js', () => ({
  SOURCE_SUMMARY_UNIT_REVISION_MISMATCH: Object.freeze({
    reason: 'content_revision_mismatch',
  }),
  readRecord: vi.fn(),
  updateRecord: vi.fn(),
  putTopicSummaryCheckpoint: vi.fn(),
  putSourceSummaryUnit: vi.fn(),
  appendProcessingLog: vi.fn(),
  flushProcessingLog: vi.fn(),
}));

vi.mock('../../../core/pipeline/capturedText.js', () => ({
  normalizeCapturedText: vi.fn((text) => String(text || '')),
}));

vi.mock('../../../core/pipeline/htmlEntities.js', () => ({
  // topicParser.js uses the real decodeEntities to canonicalize label
  // segments; the passthrough keeps entity-free fixture labels intact.
  decodeEntities: vi.fn((s) => s),
}));

vi.mock('../../../core/pipeline/sentenceSplitter.js', () => ({
  splitSentences: vi.fn(),
}));

vi.mock('../../../core/llm/llm.js', () => ({
  callLLMWithRetry: vi.fn(),
}));

vi.mock('../../../core/llm/concurrency.js', () => ({
  createAdjustableLimiter: vi.fn(() => pipelineLimiter),
  createLimiter: vi.fn(() => (fn) => fn()),
  parallelMap: vi.fn(async (items, limit, fn) => {
    const results = [];
    for (let i = 0; i < items.length; i++) {
      results.push(await fn(items[i], i));
    }
    return results;
  }),
}));

vi.mock('../../../core/llm/providers.js', () => ({
  getActiveProvider: vi.fn(async () => null),
}));

vi.mock('../../../shared/runtime/verboseLogSettings.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getStoredVerboseLogs: vi.fn(async () => false),
}));

vi.mock('../../../core/settings/language.js', () => ({
  getStoredPreferContentLanguage: vi.fn(async () => false),
}));

vi.mock('../../../core/settings/llmConcurrency.js', () => ({
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS: 4,
  MAX_PARALLEL_LLM_REQUESTS_KEY: 'pagetollm-max-parallel-llm-requests',
  getStoredMaxParallelLlmRequests: vi.fn(async () => 4),
  normalizeMaxParallelLlmRequests: vi.fn((value) => Number(value) || 4),
}));

const { runPipeline } = createPipelineRunner({
  runtimeFactory: createPipelineRuntime,
  settings: {
    getPreferContentLanguage: getStoredPreferContentLanguage,
    getVerboseLogs: getStoredVerboseLogs,
    getMaxParallelLlmRequests: getStoredMaxParallelLlmRequests,
    normalizeMaxParallelLlmRequests,
    subscribeToMaxParallelLlmRequests: vi.fn(() => () => {}),
  },
  providerRepository: { getActiveProvider },
  llm: { callLLMWithRetry: llm.callLLMWithRetry },
  limiterFactory: () => pipelineLimiter,
  telemetry: { wrapCallLLMWithRetry },
  logger: { info: vi.fn(), error: vi.fn() },
});

function makeRecord(key, htmlContent) {
  return {
    key,
    html: htmlContent,
    contentRevision: 'test-revision',
    summaryCheckpointContentRevision: 'test-revision',
    status: 'pending',
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
  };
}

const LONG_SUMMARY_TEXT =
  `Acme reported revenue growth across three regions while executives said supply costs eased, customer renewals improved, new enterprise contracts expanded, hiring remained selective, product upgrades should support margins through the next fiscal quarter, and overseas demand is recovering steadily. ${'Additional context supports the reported results. '.repeat(100)}`.trim();

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn) => {
    if (typeof fn === 'function') fn();
    return 0;
  });
  storage.readRecord.mockResolvedValue(null);
  storage.updateRecord.mockImplementation(async (key, patch) => ({
    key,
    ...patch,
    updatedAt: Date.now(),
  }));
  const topicSummaries = {};
  const sourceSummaryUnits = {};
  storage.putTopicSummaryCheckpoint.mockImplementation(async (key, topicPath, summary) => {
    topicSummaries[topicPath] = summary;
    return storage.updateRecord(key, { topic_summaries: { ...topicSummaries } });
  });
  storage.putSourceSummaryUnit.mockImplementation(async (key, unit) => {
    sourceSummaryUnits[unit.unitId] = unit;
    return storage.updateRecord(key, { source_summary_units: { ...sourceSummaryUnits } });
  });
  storage.appendProcessingLog.mockResolvedValue(undefined);
  storage.flushProcessingLog.mockResolvedValue(undefined);
  capturedText.normalizeCapturedText.mockReturnValue('');
  sentenceSplitter.splitSentences.mockReturnValue([]);
  llm.callLLMWithRetry.mockResolvedValue('');
  getActiveProvider.mockResolvedValue(null);
  getStoredPreferContentLanguage.mockResolvedValue(false);
});

describe('createPipelineRunner', () => {
  it('does not apply a stale concurrency read after a newer setting event', async () => {
    let onConcurrencyChanged;
    let resolveInitialLimit;
    const limiter = { run: vi.fn((fn) => fn()), setLimit: vi.fn() };
    const runner = createPipelineRunner({
      runtimeFactory: createPipelineRuntime,
      settings: {
        getPreferContentLanguage: vi.fn(async () => false),
        getVerboseLogs: vi.fn(async () => false),
        getMaxParallelLlmRequests: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveInitialLimit = resolve;
            }),
        ),
        normalizeMaxParallelLlmRequests: Number,
        subscribeToMaxParallelLlmRequests: vi.fn((listener) => {
          onConcurrencyChanged = listener;
          return () => {};
        }),
      },
      providerRepository: { getActiveProvider: vi.fn(async () => null) },
      llm: { callLLMWithRetry: vi.fn() },
      limiterFactory: () => limiter,
      telemetry: { wrapCallLLMWithRetry: (call) => call },
      logger: { info: vi.fn(), error: vi.fn() },
    });

    const pendingRun = runner.runPipeline('concurrency-race');
    onConcurrencyChanged('7');
    resolveInitialLimit(2);
    await expect(pendingRun).rejects.toThrow('record not found');

    expect(limiter.setLimit).toHaveBeenCalledTimes(1);
    expect(limiter.setLimit).toHaveBeenCalledWith(7);
    runner.dispose();
  });

  it('owns one concurrency subscription and disposes it exactly once', () => {
    let onConcurrencyChanged;
    const unsubscribe = vi.fn();
    const limiter = { run: vi.fn(), setLimit: vi.fn() };
    const limiterFactory = vi.fn(() => limiter);
    const subscribeToMaxParallelLlmRequests = vi.fn((listener) => {
      onConcurrencyChanged = listener;
      return unsubscribe;
    });
    const runner = createPipelineRunner({
      runtimeFactory: vi.fn(),
      settings: {
        getPreferContentLanguage: vi.fn(),
        getVerboseLogs: vi.fn(),
        getMaxParallelLlmRequests: vi.fn(),
        normalizeMaxParallelLlmRequests: (value) => Math.max(1, Number(value) || 4),
        subscribeToMaxParallelLlmRequests,
      },
      providerRepository: { getActiveProvider: vi.fn() },
      llm: { callLLMWithRetry: vi.fn() },
      limiterFactory,
      telemetry: { wrapCallLLMWithRetry: (call) => call },
      logger: { info: vi.fn(), error: vi.fn() },
    });

    expect(limiterFactory).toHaveBeenCalledTimes(1);
    expect(subscribeToMaxParallelLlmRequests).toHaveBeenCalledTimes(1);
    onConcurrencyChanged('7');
    expect(limiter.setLimit).toHaveBeenCalledWith(7);

    runner.dispose();
    runner.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    limiter.setLimit.mockClear();
    onConcurrencyChanged('9');
    expect(limiter.setLimit).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

describe('runPipeline', () => {
  it('clears stale topic and summary state before a fresh run', async () => {
    storage.readRecord.mockResolvedValue({
      ...makeRecord('fresh-clear', `<p>${LONG_SUMMARY_TEXT}</p>`),
      topics: [{ name: 'Old', sentences: [1] }],
      topic_summaries: { Old: { text: 'Old summary.' } },
      topic_summary_index: { Old: { text: 'Old summary.' } },
      source_summary_units: { old: { unitId: 'old' } },
    });
    capturedText.normalizeCapturedText.mockReturnValue(LONG_SUMMARY_TEXT);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.TOPIC_RANGES ? 'Fresh: 0' : 'Fresh summary.',
    );

    await runPipeline('fresh-clear');

    expect(storage.updateRecord.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        status: 'splitting',
        topics: [],
        topic_summaries: {},
        topic_summary_index: {},
        source_summary_units: {},
        forceFinalize: false,
      }),
    );
    const done = storage.updateRecord.mock.calls.find(([, patch]) => patch.status === 'done');
    expect(done[1].topic_summaries.Old).toBeUndefined();
    expect(done[1].topic_summaries.Fresh.runs[0].text).toBe('Fresh summary.');
  });

  it('keeps a fresh summary failure available for review', async () => {
    storage.readRecord.mockResolvedValue(
      makeRecord('fresh-failure', `<p>${LONG_SUMMARY_TEXT}</p>`),
    );
    capturedText.normalizeCapturedText.mockReturnValue(LONG_SUMMARY_TEXT);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: LONG_SUMMARY_TEXT, start: 0, end: LONG_SUMMARY_TEXT.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) => {
      if (taskType === LLM_TASK_TYPES.TOPIC_RANGES) return 'Fresh: 0';
      throw new Error('LLM down');
    });

    await runPipeline('fresh-failure');

    expect(storage.updateRecord.mock.calls.some(([, patch]) => patch.status === 'done')).toBe(
      false,
    );
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) => patch.status === 'needs_attention'),
    ).toBe(true);
  });

  it('finalizes a fresh run without summary calls when summaries are disabled', async () => {
    const source = 'Sentence one. Sentence two.';
    storage.readRecord.mockResolvedValue({
      ...makeRecord('fresh-disabled', `<p>${source}</p>`),
      skipSummaries: true,
    });
    capturedText.normalizeCapturedText.mockReturnValue(source);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockResolvedValue('Fresh: 0-1');

    await runPipeline('fresh-disabled');

    expect(llm.callLLMWithRetry.mock.calls.map(([options]) => options.taskType)).toEqual([
      LLM_TASK_TYPES.TOPIC_RANGES,
    ]);
    const done = storage.updateRecord.mock.calls.find(([, patch]) => patch.status === 'done');
    expect(done[1]).toEqual(
      expect.objectContaining({
        topic_summaries: {},
        topic_summary_index: {},
        summariesDisabled: true,
      }),
    );
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        patch.topics?.some((topic) => topic.name === 'Fresh'),
      ),
    ).toBe(true);
  });

  it('retries a parse failure and logs verbose diagnostics for the failed response', async () => {
    getStoredVerboseLogs.mockResolvedValueOnce(true);
    const source = 'A. B. C.';
    storage.readRecord.mockResolvedValue(makeRecord('parse-retry', `<p>${source}</p>`));
    capturedText.normalizeCapturedText.mockReturnValue(source);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'A.', start: 0, end: 2 },
      { text: 'B.', start: 3, end: 5 },
      { text: 'C.', start: 6, end: 8 },
    ]);
    let attempts = 0;
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) => {
      if (taskType === LLM_TASK_TYPES.TOPIC_RANGES) {
        attempts++;
        return attempts === 1 ? 'Invalid response' : 'Fresh: 0-2';
      }
      return 'Summary.';
    });

    await runPipeline('parse-retry');

    expect(attempts).toBe(2);
    expect(storage.updateRecord.mock.calls.some(([, patch]) => patch.status === 'done')).toBe(true);
    expect(storage.appendProcessingLog).toHaveBeenCalledWith(
      'parse-retry',
      'topic_ranges_parse_diagnostics',
      expect.objectContaining({ attempt: 1 }),
      expect.anything(),
    );
    expect(storage.appendProcessingLog).toHaveBeenCalledWith(
      'parse-retry',
      'topic_ranges_raw_response',
      expect.objectContaining({ attempt: 1, response: 'Invalid response' }),
      expect.anything(),
    );
  });

  it.each([
    ['stale', { summaryCheckpointContentRevision: 'old-revision' }],
    ['missing', { summaryCheckpointContentRevision: undefined }],
  ])('rebuilds a %s revision checkpoint and logs the mismatch', async (_, revision) => {
    const source = 'Fresh sentence.';
    storage.readRecord.mockResolvedValue({
      ...makeRecord('stale-checkpoint', `<p>${source}</p>`),
      status: 'summarizing',
      ...revision,
      sentences: ['Old sentence.'],
      topics: [{ name: 'Old', sentences: [1] }],
      topic_summaries: { Old: { runs: [{ sentences: [1], text: 'Old summary.' }] } },
    });
    capturedText.normalizeCapturedText.mockReturnValue(source);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: source, start: 0, end: source.length },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.TOPIC_RANGES ? 'Fresh: 0' : 'Fresh summary.',
    );

    await runPipeline('stale-checkpoint');

    expect(capturedText.normalizeCapturedText).toHaveBeenCalled();
    const done = storage.updateRecord.mock.calls.find(([, patch]) => patch.status === 'done');
    expect(done[1].topic_summaries.Old).toBeUndefined();
    expect(done[1].topic_summaries.Fresh.runs[0].text).toBe(source);
    expect(storage.appendProcessingLog).toHaveBeenCalledWith(
      'stale-checkpoint',
      'pipeline_resume_rejected',
      expect.objectContaining({ reason: 'content_revision_mismatch' }),
      expect.anything(),
    );
  });

  it('configures the shared LLM limiter from the stored setting', async () => {
    getStoredMaxParallelLlmRequests.mockResolvedValueOnce(2);
    storage.readRecord.mockResolvedValue(makeRecord('limited', '<p></p>'));

    await runPipeline('limited');

    expect(pipelineLimiter.setLimit).toHaveBeenCalledWith(2);
  });

  it('binds every request to the provider snapshot used for request sizing', async () => {
    const provider = {
      id: 'large-provider',
      name: 'Large provider',
      type: 'openai_comp',
      model: 'large-model',
      url: 'http://large.local',
      token: '',
      contextWindowTokens: 8192,
    };
    getActiveProvider.mockResolvedValue(provider);
    const plainText = 'Sentence one. Sentence two.';
    storage.readRecord.mockResolvedValue(makeRecord('provider-snapshot', `<p>${plainText}</p>`));
    capturedText.normalizeCapturedText.mockReturnValue(plainText);
    sentenceSplitter.splitSentences.mockReturnValue([
      { text: 'Sentence one.', start: 0, end: 13 },
      { text: 'Sentence two.', start: 14, end: 27 },
    ]);
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.TOPIC_RANGES ? 'Tech>All: 0-1' : 'Summary.',
    );

    await runPipeline('provider-snapshot');

    expect(getActiveProvider).toHaveBeenCalledTimes(1);
    expect(llm.callLLMWithRetry).toHaveBeenCalled();
    for (const [options] of llm.callLLMWithRetry.mock.calls) {
      expect(options.provider).toBe(provider);
    }
  });

  it('marks done with empty topics when no sentences are found', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('key2', '<p></p>'));
    capturedText.normalizeCapturedText.mockReturnValue('');
    sentenceSplitter.splitSentences.mockReturnValue([]);

    await runPipeline('key2');

    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key2',
      expect.objectContaining({
        status: 'done',
        topics: [],
        topic_summaries: {},
        progress: { stage: 'done', done: 0, total: 0 },
      }),
      expect.anything(),
    );
  });

  it('throws when record is not found', async () => {
    storage.readRecord.mockResolvedValue(null);
    await expect(runPipeline('missing')).rejects.toThrow('record not found: missing');
  });

  it('stores error status and re-throws on pipeline failure', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('key4', '<p>text</p>'));
    capturedText.normalizeCapturedText.mockImplementation(() => {
      throw new Error('HTML parse failed');
    });

    await expect(runPipeline('key4')).rejects.toThrow('HTML parse failed');

    expect(storage.updateRecord).toHaveBeenCalledWith(
      'key4',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('HTML parse failed'),
      }),
      expect.anything(),
    );
  });

  it('returns quietly when cancellation is already signalled and still flushes logs', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      runPipeline('cancelled-before-start', { signal: controller.signal }),
    ).resolves.toBe(undefined);

    expect(storage.readRecord).not.toHaveBeenCalled();
    expect(storage.updateRecord).not.toHaveBeenCalled();
    expect(storage.flushProcessingLog).toHaveBeenCalledWith('cancelled-before-start');
  });

  it('rethrows the pipeline failure when persisting its error status also fails', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('error-write-fails', '<p>text</p>'));
    capturedText.normalizeCapturedText.mockImplementation(() => {
      throw new Error('original processing failure');
    });
    storage.updateRecord.mockImplementation(async (_key, patch) => {
      if (patch.status === 'error') throw new Error('storage write failed');
      return { ...patch };
    });

    await expect(runPipeline('error-write-fails')).rejects.toThrow('original processing failure');

    expect(storage.updateRecord).toHaveBeenCalledWith(
      'error-write-fails',
      expect.objectContaining({ status: 'error' }),
      expect.anything(),
    );
    expect(storage.flushProcessingLog).toHaveBeenCalledWith('error-write-fails');
  });

  it('flushes buffered logs after a successful pipeline run', async () => {
    storage.readRecord.mockResolvedValue(makeRecord('flush-on-success', '<p></p>'));

    await runPipeline('flush-on-success');

    expect(storage.flushProcessingLog).toHaveBeenCalledWith('flush-on-success');
  });

  it('persists an unrelated error that settles after the signal is aborted', async () => {
    const controller = new AbortController();
    storage.readRecord.mockResolvedValue(makeRecord('cancelled-plain-error', '<p>text</p>'));
    capturedText.normalizeCapturedText.mockImplementation(() => {
      controller.abort();
      throw new Error('transport closed while aborting');
    });

    await expect(
      runPipeline('cancelled-plain-error', { signal: controller.signal }),
    ).rejects.toThrow('transport closed while aborting');

    expect(
      storage.updateRecord.mock.calls.some(
        ([key, patch]) => key === 'cancelled-plain-error' && patch.status === 'error',
      ),
    ).toBe(true);
  });

  it('resumes a summarizing record without redoing topic ranges and only summarizes missing topics', async () => {
    // A record left in 'summarizing' with topics + one completed summary, as
    // happens after a service-worker recycle mid-summary.
    storage.readRecord.mockResolvedValue({
      key: 'resume1',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      contentRevision: 'resume-1-revision',
      summaryCheckpointContentRevision: 'resume-1-revision',
      sentences: ['Alpha.', LONG_SUMMARY_TEXT],
      topics: [
        { name: 'A', sentences: [1] },
        { name: 'B', sentences: [2] },
      ],
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: 'Existing A summary.' }], source_sentences: [1] },
      },
      topic_summary_index: {},
      summaryErrors: [{ topic: 'stale-error' }],
    });

    const summaryPrompts = [];
    llm.callLLMWithRetry.mockImplementation(async ({ taskType, prompt }) => {
      if (taskType === LLM_TASK_TYPES.ARTICLE_SUMMARY) {
        summaryPrompts.push(prompt);
        return 'Fresh B summary.';
      }
      return '';
    });

    await runPipeline('resume1');

    // Topic-ranges stage must be skipped entirely on resume.
    const topicRangeCalls = llm.callLLMWithRetry.mock.calls.filter(
      (c) => c[0].taskType === LLM_TASK_TYPES.TOPIC_RANGES,
    );
    expect(topicRangeCalls).toHaveLength(0);
    // Captured-text normalization / sentence splitting must be skipped too.
    expect(capturedText.normalizeCapturedText).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();

    // Only the missing topic (B) should be summarized; A is reused.
    expect(summaryPrompts).toHaveLength(1);
    expect(summaryPrompts[0]).toContain(LONG_SUMMARY_TEXT);

    const resumeCall = storage.updateRecord.mock.calls.find(
      (call) => call[1].status === 'summarizing' && call[1].summariesIncomplete === false,
    );
    expect(resumeCall).toBeDefined();
    expect(resumeCall[1].summaryErrors).toEqual([]);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries.A.runs[0].text).toBe('Existing A summary.');
    expect(doneCall[1].topic_summaries.B.runs[0].text).toBe('Fresh B summary.');
  });

  it('uses the checkpoint language preference when completing a resumed summary run', async () => {
    getStoredPreferContentLanguage.mockResolvedValue(false);
    storage.readRecord.mockResolvedValue({
      key: 'resume-language',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      contentRevision: 'resume-language-revision',
      summaryCheckpointContentRevision: 'resume-language-revision',
      summaryCheckpointPreferContentLanguage: true,
      sentences: [LONG_SUMMARY_TEXT],
      topics: [{ name: 'A', sentences: [1] }],
      topic_summaries: {},
      topic_summary_index: {},
    });
    llm.callLLMWithRetry.mockResolvedValue('Resumen.');

    await runPipeline('resume-language');

    expect(llm.callLLMWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('LANGUAGE:') }),
      expect.any(Number),
    );
  });

  it('refuses a current summarizing checkpoint with an empty topic list without clearing it', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'resume-empty-topics',
      html: '<p>Source.</p>',
      status: 'summarizing',
      contentRevision: 'resume-empty-revision',
      summaryCheckpointContentRevision: 'resume-empty-revision',
      sentences: ['Source.'],
      topics: [],
      topic_summaries: { A: { runs: [{ sentences: [1], text: 'Keep.' }] } },
    });

    await expect(runPipeline('resume-empty-topics')).rejects.toThrow(
      'saved sentence checkpoint is incomplete',
    );

    expect(capturedText.normalizeCapturedText).not.toHaveBeenCalled();
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        Object.prototype.hasOwnProperty.call(patch, 'topics'),
      ),
    ).toBe(false);
  });

  it('refuses an incomplete resume without erasing valid summary checkpoints', async () => {
    // Same shape as a normal resumable checkpoint, except `sentences` is empty.
    // The stale topics reference sentence ids that no longer resolve to any
    // text, so resuming would silently produce blank summaries.
    storage.readRecord.mockResolvedValue({
      key: 'resumeNoSentences',
      html: '<p>AB. CD.</p>',
      status: 'summarizing',
      contentRevision: 'resume-invalid-revision',
      summaryCheckpointContentRevision: 'resume-invalid-revision',
      sentences: [],
      topics: [{ name: 'A', sentences: [1] }],
      topic_summaries: {
        A: { runs: [{ sentences: [1], text: 'Keep this summary.' }], source_sentences: [1] },
      },
      topic_summary_index: {
        A: {
          runs: [{ sentences: [1], text: 'Keep this summary.' }],
          level: 0,
          source_sentences: [1],
        },
      },
    });
    await expect(runPipeline('resumeNoSentences')).rejects.toThrow(
      'saved sentence checkpoint is incomplete',
    );

    // Refusal may update status/error, but it must not enter computeTopics,
    // whose first write clears every topic and summary checkpoint.
    expect(capturedText.normalizeCapturedText).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    expect(
      storage.updateRecord.mock.calls.some(([, patch]) =>
        ['topics', 'topic_summaries', 'topic_summary_index'].some((field) =>
          Object.prototype.hasOwnProperty.call(patch, field),
        ),
      ),
    ).toBe(false);
    expect(storage.updateRecord).toHaveBeenCalledWith(
      'resumeNoSentences',
      expect.objectContaining({
        status: 'error',
        error: expect.stringContaining('saved sentence checkpoint is incomplete'),
      }),
      expect.anything(),
    );

    const rejectionLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume_rejected',
    );
    expect(rejectionLog).toBeDefined();

    const resumeLog = storage.appendProcessingLog.mock.calls.find(
      (call) => call[1] === 'pipeline_resume',
    );
    expect(resumeLog).toBeUndefined();
  });

  it('skips all summary work when the run skips summaries and the record is resuming', async () => {
    storage.readRecord.mockResolvedValue({
      key: 'disabled2',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      contentRevision: 'disabled-2-revision',
      summaryCheckpointContentRevision: 'disabled-2-revision',
      skipSummaries: true,
      sentences: ['Alpha.', 'Beta.'],
      topics: [{ name: 'A', sentences: [1, 2] }],
      topic_summaries: { A: { runs: [{ sentences: [1, 2], text: 'Existing summary.' }] } },
      topic_summary_index: { A: { runs: [{ sentences: [1, 2], text: 'Existing summary.' }] } },
    });
    llm.callLLMWithRetry.mockResolvedValue('SHOULD_NOT_BE_CALLED');

    await runPipeline('disabled2');

    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();
    // The resume path must not redo captured-text normalization / sentence splitting either.
    expect(capturedText.normalizeCapturedText).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    // Disabling a resumed stage must not erase already-paid-for summaries.
    expect(doneCall[1].topic_summaries).toBeUndefined();
    expect(doneCall[1].topic_summary_index).toBeUndefined();
    expect(doneCall[1].summariesDisabled).toBe(true);
  });

  it('generates summaries via the resume path for a record that finished without them', async () => {
    // Shape produced by the generateRecordSummaries handler: topics/sentences
    // kept from the original run, summaries empty, skipSummaries overridden to
    // false, status set back to 'summarizing'.
    storage.readRecord.mockResolvedValue({
      key: 'gen1',
      html: '<p>ignored on resume</p>',
      status: 'summarizing',
      contentRevision: 'gen-1-revision',
      summaryCheckpointContentRevision: 'gen-1-revision',
      skipSummaries: false,
      summariesDisabled: true,
      sentences: [LONG_SUMMARY_TEXT],
      topics: [{ name: 'Tech>All', sentences: [1] }],
      topic_summaries: {},
      topic_summary_index: {},
    });
    llm.callLLMWithRetry.mockImplementation(async ({ taskType }) =>
      taskType === LLM_TASK_TYPES.ARTICLE_SUMMARY ? 'Generated summary.' : '',
    );

    await runPipeline('gen1');

    // No reprocessing: captured-text normalization, sentence splitting, and topic ranges are
    // all reused from the stored record.
    expect(capturedText.normalizeCapturedText).not.toHaveBeenCalled();
    expect(sentenceSplitter.splitSentences).not.toHaveBeenCalled();
    expect(
      llm.callLLMWithRetry.mock.calls.some(
        ([opts]) => opts.taskType === LLM_TASK_TYPES.TOPIC_RANGES,
      ),
    ).toBe(false);

    const doneCall = storage.updateRecord.mock.calls.find((call) => call[1].status === 'done');
    expect(doneCall).toBeDefined();
    expect(doneCall[1].topic_summaries['Tech>All'].runs[0].text).toBe('Generated summary.');
    // The "intentionally no summaries" outcome flag is cleared on finalize.
    expect(doneCall[1].summariesDisabled).toBe(false);
  });
});
