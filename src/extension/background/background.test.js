import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readRecord, writeRecord, updateRecord } from '../../core/storage/storage.js';
import {
  DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
} from '../../core/settings/llmConcurrency.js';
import { createChromeStorageFake } from '../../../test/fakes/chromeStorageFake.mjs';

// The checkpoint predicates mirror the real ones in orchestrator.js (their own
// rules are covered there); what these service-worker tests need to replace is
// the pipeline itself, so the runner returned by `createPipelineRunner` hands
// back a stub instead of executing real LLM work.
//
// `runPipeline` is exported by this mock purely as a test handle: background.js
// no longer imports it, but the assertions below reach the same stub through
// `await import('.../orchestrator.js')` rather than threading it through every
// test. `vi.hoisted` keeps the two references the same object.
//
// The deps background.js passes to `createPipelineRunner` are discarded by this
// stub, so the composition itself is covered separately in
// 'pipeline runner composition' below.
const { mockedRunPipeline, pipelineCallListeners, signalPipelineCall } = vi.hoisted(() => {
  const listeners = new Set();
  const signal = () => {
    for (const listener of listeners) listener();
  };
  return {
    pipelineCallListeners: listeners,
    signalPipelineCall: signal,
    mockedRunPipeline: vi.fn((...args) => {
      signal(args);
      return Promise.resolve();
    }),
  };
});
vi.mock('./pipeline/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runPipeline: mockedRunPipeline,
    createPipelineRunner: vi.fn(() => ({
      runPipeline: mockedRunPipeline,
      dispose: vi.fn(),
    })),
  };
});

// `updateRecord` is wrapped (not replaced) so the real implementation still
// runs by default; individual tests can override it with
// `updateRecord.mockRejectedValueOnce(...)` to simulate a storage failure
// distinct from the mocked `runPipeline` rejection above.
vi.mock('../../core/storage/storage.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, updateRecord: vi.fn(actual.updateRecord) };
});

const STALE_MS = 10 * 60 * 1000;

function makeChromeMock() {
  const storageFake = createChromeStorageFake();
  // One object, handed out as `chrome.runtime` and closed over by the storage
  // callbacks below. It used to be spread into the returned mock, which meant a
  // `lastError` a test set on `chrome.runtime` was never cleared by the reset in
  // those callbacks — real Chrome scopes `lastError` to the callback that is
  // running, so a stale one would leak into unrelated calls.
  const runtime = Object.assign(storageFake.runtime, {
    id: 'test-id',
    lastError: null,
    getURL: vi.fn((path = '') => `chrome-extension://test-id/${path}`),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  });

  const chromeLocal = storageFake.storage.local;

  return {
    storage: {
      local: chromeLocal,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime,
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      get: vi.fn((_name, cb) => cb(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setIcon: vi.fn(),
    },
  };
}

// Records are physically normalized across independently updated documents
// (see src/core/storage/storage.js); seeding/reading a record for a test goes through
// the same writeRecord/readRecord functions background.js itself uses,
// rather than poking the mock store directly. Requires `chrome` to already
// be stubbed to `chromeMock` (writeRecord/readRecord read the global).
async function seedRecord(chromeMock, rec) {
  await writeRecord(rec);
}

// Detached pipeline starts consist of promise continuations over the in-memory
// Chrome storage fake. Flush those continuations directly instead of waiting
// for arbitrary timer delays.
async function flushMicrotasks(turns = 30) {
  for (let i = 0; i < turns; i += 1) {
    await Promise.resolve();
  }
}

function waitForPipelineCalls(count, timeoutMs = 2000) {
  if (mockedRunPipeline.mock.calls.length >= count) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeoutId);
      pipelineCallListeners.delete(listener);
    };
    const listener = () => {
      if (mockedRunPipeline.mock.calls.length < count) return;
      cleanup();
      resolve();
    };
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Expected runPipeline to be called ${count} times, but it was called ${mockedRunPipeline.mock.calls.length} times`,
        ),
      );
    }, timeoutMs);
    pipelineCallListeners.add(listener);
  });
}

async function drainBootstrapResume() {
  await flushMicrotasks();
}

async function loadWorker({ records = [], chromeMock = makeChromeMock() } = {}) {
  vi.stubGlobal('chrome', chromeMock);
  for (const record of records) await seedRecord(chromeMock, record);
  const worker = await import('./background.js');
  return { chromeMock, worker };
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>hello</p>',
    text: '',
    status: 'pending',
    error: null,
    progress: { stage: 'queued', done: 0, total: 0 },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

function completeSummaryCheckpoint() {
  return {
    contentRevision: 'checkpoint-revision',
    summaryCheckpointContentRevision: 'checkpoint-revision',
    sentences: ['One.', 'Two.'],
    topics: [{ name: 'Checkpoint', sentences: [1, 2] }],
  };
}

// `createPipelineRunner` is mocked everywhere else in this file, which means
// nothing else executes the dependency object background.js builds for it. A
// typo in the watched storage key, a limiter seeded from the wrong default or a
// missing settings reader would all be invisible. These tests run the deps the
// composition root actually passed.
describe('pipeline runner composition', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function importWithCapturedDeps() {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { createPipelineRunner } = await import('./pipeline/orchestrator.js');
    await import('./background.js');
    expect(createPipelineRunner).toHaveBeenCalledTimes(1);
    return { chromeMock, deps: createPipelineRunner.mock.calls[0][0] };
  }

  it('watches the real concurrency storage key and normalizes what it reads', async () => {
    const { chromeMock, deps } = await importWithCapturedDeps();

    const onValue = vi.fn();
    deps.settings.subscribeToMaxParallelLlmRequests(onValue);
    const [handler] = chromeMock.storage.onChanged.addListener.mock.calls.at(-1);

    handler({ [MAX_PARALLEL_LLM_REQUESTS_KEY]: { newValue: 9 } }, 'local');
    expect(onValue).toHaveBeenCalledWith(9);

    // An unrelated key must not move the pipeline's concurrency.
    onValue.mockClear();
    handler({ 'some-other-key': { newValue: 1 } }, 'local');
    expect(onValue).not.toHaveBeenCalled();

    expect(deps.settings.normalizeMaxParallelLlmRequests('9')).toBe(9);
  });

  it('seeds the limiter with the same default the setting normalizes towards', async () => {
    const { deps } = await importWithCapturedDeps();

    const limiter = deps.limiterFactory();
    let started = 0;
    // Standard pipeline work leaves one of the aggregate slots available for
    // priority chat work.
    for (let i = 0; i < DEFAULT_MAX_PARALLEL_LLM_REQUESTS + 3; i++) {
      void limiter.run(() => {
        started++;
        return new Promise(() => {});
      });
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(started).toBe(DEFAULT_MAX_PARALLEL_LLM_REQUESTS - 1);
    expect(deps.settings.normalizeMaxParallelLlmRequests(undefined)).toBe(
      DEFAULT_MAX_PARALLEL_LLM_REQUESTS,
    );
  });

  it('supplies every settings reader and collaborator the runner requires', async () => {
    const { deps } = await importWithCapturedDeps();

    for (const name of [
      'getPreferContentLanguage',
      'getVerboseLogs',
      'getMaxParallelLlmRequests',
      'normalizeMaxParallelLlmRequests',
      'subscribeToMaxParallelLlmRequests',
    ]) {
      expect(typeof deps.settings[name], `settings.${name}`).toBe('function');
    }
    expect(typeof deps.runtimeFactory).toBe('function');
    expect(typeof deps.limiterFactory).toBe('function');
    expect(typeof deps.providerRepository.getActiveProvider).toBe('function');
    expect(typeof deps.llm.callLLMWithRetry).toBe('function');
    expect(typeof deps.telemetry.wrapCallLLMWithRetry).toBe('function');
    expect(typeof deps.logger.info).toBe('function');
    expect(typeof deps.logger.error).toBe('function');
  });
});

describe('background pipeline lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('submit starts a new job for a fresh record', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });

    expect(result.ok).toBe(true);
    expect(result.key).toBeDefined();

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(
      result.key,
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('starts independent pipelines for different pages concurrently', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const [resultA, resultB] = await Promise.all([
      handleSubmit({
        html: '<p>page A unique content</p>',
        sourceUrl: 'https://example.com/page-a',
      }),
      handleSubmit({
        html: '<p>page B unique content</p>',
        sourceUrl: 'https://example.com/page-b',
      }),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(resultA.key).not.toBe(resultB.key);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline).toHaveBeenCalledWith(
      resultA.key,
      expect.objectContaining({ signal: expect.any(Object) }),
    );
    expect(runPipeline).toHaveBeenCalledWith(
      resultB.key,
      expect.objectContaining({ signal: expect.any(Object) }),
    );

    const storedA = await readRecord(resultA.key);
    const storedB = await readRecord(resultB.key);
    expect(storedA.html).toBe('<p>page A unique content</p>');
    expect(storedB.html).toBe('<p>page B unique content</p>');
    expect(storedA.sourceUrl).toBe('https://example.com/page-a');
    expect(storedB.sourceUrl).toBe('https://example.com/page-b');
  });

  it('keeps separate blocks picked from one page as independent records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const url = 'https://example.com/long-article';
    const chapter1 = await handleSubmit({
      html: '<p>chapter one</p>',
      capturedText: 'chapter one',
      captureVersion: 2,
      sourceUrl: url,
      selectors: ['#chapter-1'],
    });
    const chapter2 = await handleSubmit({
      html: '<p>chapter two</p>',
      capturedText: 'chapter two',
      captureVersion: 2,
      sourceUrl: url,
      selectors: ['#chapter-2'],
    });

    expect(chapter1.key).not.toBe(chapter2.key);
    expect((await readRecord(chapter1.key)).capturedText).toBe('chapter one');
    expect((await readRecord(chapter2.key)).capturedText).toBe('chapter two');

    // Re-picking the first block still reuses its own record.
    const again = await handleSubmit({
      html: '<p>chapter one revised</p>',
      capturedText: 'chapter one revised',
      captureVersion: 2,
      sourceUrl: url,
      selectors: ['#chapter-1'],
    });
    expect(again.key).toBe(chapter1.key);
    expect((await readRecord(chapter2.key)).capturedText).toBe('chapter two');
  });

  it('does not start duplicate jobs for the same key', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    let resolvePipeline;
    runPipeline.mockImplementationOnce(() => {
      signalPipelineCall();
      return new Promise((resolve) => {
        resolvePipeline = resolve;
      });
    });

    const result1 = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });
    const result2 = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });

    expect(result1.key).toBe(result2.key);

    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    resolvePipeline();
    await flushMicrotasks();
  });

  it('commits one record when two identical submissions race the create path', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    // Capture the run id the started job is working under, so the assertion
    // below can tell whether a second creator reset the record out from under
    // it (every later CAS from that job would then be rejected).
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    let runningPipelineRunId = null;
    runPipeline.mockImplementationOnce(async (key) => {
      runningPipelineRunId = (await readRecord(key)).pipelineRunId;
    });

    // Both callers read the missing record and clear the isActive guard before
    // either writes: the awaits in between (hash, read, settings) interleave.
    const [first, second] = await Promise.all([
      handleSubmit({ html: '<p>same content</p>', sourceUrl: 'https://example.com/race' }),
      handleSubmit({ html: '<p>same content</p>', sourceUrl: 'https://example.com/race' }),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.key).toBe(second.key);

    expect(runPipeline).toHaveBeenCalledTimes(1);
    const stored = await readRecord(first.key);
    expect(stored.pipelineRunId).toBe(runningPipelineRunId);
  });

  it('returns existing done record without restarting', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done1', {
      status: 'done',
      updatedAt: Date.now(),
      captureVersion: 2,
      capturedText: 'hello',
    });
    await seedRecord(chromeMock, rec);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result = await handleSubmit({
      html: '<p>hello</p>',
      captureVersion: 2,
      capturedText: 'hello',
      sourceUrl: 'https://example.com',
      selectors: ['main'],
    });

    expect(result.ok).toBe(true);
    expect(result.key).toBe('done1');
    expect((await readRecord('done1')).selectors).toEqual(['main']);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('reprocesses a done URL when the newly captured content differs', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done-changed', {
      status: 'done',
      sourceUrl: 'https://example.com/changed',
      html: '<p>old</p>',
      capturedText: 'old',
      captureVersion: 2,
    });
    await seedRecord(chromeMock, rec);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result = await handleSubmit({
      html: '<p>new</p>',
      capturedText: 'new',
      captureVersion: 2,
      sourceUrl: 'https://example.com/changed',
    });

    expect(result).toEqual({ ok: true, key: 'done-changed' });
    expect((await readRecord('done-changed')).capturedText).toBe('new');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('resolveSummaryErrors retry resumes the pipeline and keeps leaf error flags', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park1', {
        ...completeSummaryCheckpoint(),
        status: 'needs_attention',
        summariesIncomplete: true,
        summaryErrors: [{ topic: 'Tech>All', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          'Tech>All': { text: '', source_sentences: [1], error: true, error_kind: 'timeout' },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'park1', action: 'retry' },
      {},
    );
    expect(res.ok).toBe(true);

    const updated = await readRecord('park1');
    expect(updated.status).toBe('summarizing');
    expect(updated.forceFinalize).toBe(false);
    expect(updated.summaryErrors).toEqual([]);
    expect(updated.summariesIncomplete).toBe(false);
    // Retry keeps the flag so the resumed run re-queries only the failed leaf.
    expect(updated.topic_summaries['Tech>All'].error).toBe(true);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledWith(
      'park1',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it.each(['retry', 'skip'])(
    'resolveSummaryErrors %s refuses an incomplete checkpoint without mutating it',
    async (action) => {
      const chromeMock = makeChromeMock();
      vi.stubGlobal('chrome', chromeMock);
      await seedRecord(
        chromeMock,
        makeRecord('park-incomplete', {
          pipelineRunId: 'imported-run',
          status: 'needs_attention',
          sentences: [],
          topics: [{ name: 'A', sentences: [1] }],
          summaryErrors: [{ topic: 'A', error_kind: 'timeout', error_message: 'x' }],
          topic_summaries: {
            A: {
              runs: [{ sentences: [1], text: 'A good surviving summary.' }],
              source_sentences: [1],
              error: true,
            },
          },
          topic_summary_index: {
            A: {
              runs: [{ sentences: [1], text: 'A good surviving summary.' }],
              level: 0,
              source_sentences: [1],
            },
          },
        }),
      );
      const before = await readRecord('park-incomplete');

      const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
      _resetJobRegistry();
      const result = await dispatchMessage(
        { type: 'resolveSummaryErrors', key: 'park-incomplete', action },
        {},
      );

      expect(result).toEqual({
        ok: false,
        error: 'The saved summary checkpoint is incomplete. Reprocess the record instead.',
      });
      expect(await readRecord('park-incomplete')).toEqual(before);
      expect(updateRecord).not.toHaveBeenCalled();
      const { runPipeline } = await import('./pipeline/orchestrator.js');
      expect(runPipeline).not.toHaveBeenCalled();
    },
  );

  it.each(['retry', 'skip'])(
    'resolveSummaryErrors %s refuses a stale checkpoint without mutating it',
    async (action) => {
      const chromeMock = makeChromeMock();
      vi.stubGlobal('chrome', chromeMock);
      await seedRecord(
        chromeMock,
        makeRecord('park-stale', {
          ...completeSummaryCheckpoint(),
          pipelineRunId: 'imported-run',
          contentRevision: 'new-revision',
          summaryCheckpointContentRevision: 'old-revision',
          status: 'needs_attention',
          summaryErrors: [{ topic: 'Checkpoint', error_kind: 'timeout', error_message: 'x' }],
          topic_summaries: {
            Checkpoint: {
              runs: [{ sentences: [1, 2], text: '' }],
              source_sentences: [1, 2],
              error: true,
            },
          },
        }),
      );
      const before = await readRecord('park-stale');

      const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
      _resetJobRegistry();
      const result = await dispatchMessage(
        { type: 'resolveSummaryErrors', key: 'park-stale', action },
        {},
      );

      expect(result).toEqual({
        ok: false,
        error: 'The saved summary checkpoint is stale. Reprocess the record instead.',
      });
      expect(await readRecord('park-stale')).toEqual(before);
      expect(updateRecord).not.toHaveBeenCalled();
      const { runPipeline } = await import('./pipeline/orchestrator.js');
      expect(runPipeline).not.toHaveBeenCalled();
    },
  );

  it('resolveSummaryErrors skip swaps leaf error flags for acceptedFailure and forces finalize', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park2', {
        ...completeSummaryCheckpoint(),
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Tech>All', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          'Tech>All': {
            runs: [
              {
                sentences: [1],
                text: '',
                error: true,
                error_kind: 'timeout',
                error_message: 'x',
              },
            ],
            source_sentences: [1],
            error: true,
            error_kind: 'timeout',
            error_message: 'x',
          },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'park2', action: 'skip' },
      {},
    );
    expect(res.ok).toBe(true);

    const updated = await readRecord('park2');
    expect(updated.status).toBe('summarizing');
    expect(updated.forceFinalize).toBe(true);
    const leaf = updated.topic_summaries['Tech>All'];
    expect(leaf.error).toBeUndefined();
    expect(leaf.error_kind).toBeUndefined();
    expect(leaf.error_message).toBeUndefined();
    // The failure is still marked, just transiently: the resumed run needs it to
    // scope ancestor summaries and stamp `forcedEmpty`, but `planSummaryWork`
    // ignores it so the leaf is reused without a re-query.
    expect(leaf.acceptedFailure).toBe(true);
    expect(leaf.runs).toEqual([{ sentences: [1], text: '', acceptedFailure: true }]);
    expect(leaf.source_sentences).toEqual([1]);
  });

  it('resolveSummaryErrors skip carries merge-only failures so resume does not repeat them', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park-merge', {
        ...completeSummaryCheckpoint(),
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Tech', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          'Tech>AI': { runs: [], source_sentences: [1, 2] },
          'Tech>Hardware': { runs: [], source_sentences: [3, 4] },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'park-merge', action: 'skip' },
      {},
    );

    expect(res.ok).toBe(true);
    const updated = await readRecord('park-merge');
    expect(updated.forceFinalize).toBe(true);
    expect(updated.acceptedMergeFailurePaths).toEqual(['Tech']);
  });

  it('serializes concurrent Retry and Skip decisions with the pipeline run id', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('park-race', {
        ...completeSummaryCheckpoint(),
        pipelineRunId: 'review-run',
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Tech>All', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          'Tech>All': {
            runs: [{ sentences: [1], text: '' }],
            source_sentences: [1],
            error: true,
          },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    // Both handlers take their snapshot before storage's queued update runs.
    // Retry is dispatched first and must retain the error marker; the stale
    // Skip must not overwrite the whole summaries field afterward.
    const [retry, skip] = await Promise.all([
      dispatchMessage({ type: 'resolveSummaryErrors', key: 'park-race', action: 'retry' }, {}),
      dispatchMessage({ type: 'resolveSummaryErrors', key: 'park-race', action: 'skip' }, {}),
    ]);

    expect(retry).toEqual({ ok: true });
    expect(skip).toEqual({ ok: true, stale: true });
    const stored = await readRecord('park-race');
    expect(stored.status).toBe('summarizing');
    expect(stored.forceFinalize).toBe(false);
    expect(stored.topic_summaries['Tech>All'].error).toBe(true);
    expect(stored.topic_summaries['Tech>All'].acceptedFailure).toBeUndefined();
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a replacement summary run started after the decision CAS', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('park-replacement-race', {
        ...completeSummaryCheckpoint(),
        pipelineRunId: 'review-run',
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Checkpoint', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          Checkpoint: {
            runs: [{ sentences: [1, 2], text: '' }],
            source_sentences: [1, 2],
            error: true,
          },
        },
      }),
    );

    const { dispatchMessage, startPipeline, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(() => {
      signalPipelineCall();
      return new Promise((resolve) => {
        resolvePipeline = resolve;
      });
    });
    const realUpdate = updateRecord.getMockImplementation();
    updateRecord.mockImplementationOnce(async (key, patch, options) => {
      const updated = await realUpdate(key, patch, options);
      // Model a keepalive taking the newly minted run after the decision owns
      // storage, but before the handler gets to its cancellation call.
      void startPipeline(key);
      await waitForPipelineCalls(1);
      expect(runPipeline).toHaveBeenCalledTimes(1);
      return updated;
    });

    await expect(
      dispatchMessage(
        { type: 'resolveSummaryErrors', key: 'park-replacement-race', action: 'retry' },
        {},
      ),
    ).resolves.toEqual({ ok: true });

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0][1].pipelineRunId).not.toBe('review-run');
    expect(runPipeline.mock.calls[0][1].signal.aborted).toBe(false);

    resolvePipeline();
  });

  it('resolveSummaryErrors retry preserves failures accepted in an earlier review', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park-chained', {
        ...completeSummaryCheckpoint(),
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Other', error_kind: 'timeout', error_message: 'new failure' }],
        topic_summaries: {
          'Tech>All': { runs: [], source_sentences: [1], acceptedFailure: true },
          'Other>All': { runs: [], source_sentences: [2], error: true },
        },
        topic_summary_index: {
          Tech: { runs: [], level: 0, source_sentences: [1] },
          Other: { runs: [], level: 0, source_sentences: [2] },
        },
        acceptedMergeFailurePaths: ['Tech'],
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'park-chained', action: 'retry' },
      {},
    );

    expect(res.ok).toBe(true);
    const updated = await readRecord('park-chained');
    expect(updated.forceFinalize).toBe(true);
    expect(updated.acceptedMergeFailurePaths).toEqual(['Tech']);
    expect(updated.topic_summary_index).toEqual({});
    expect(updated.topic_summaries['Tech>All'].acceptedFailure).toBe(true);
    expect(updated.topic_summaries['Other>All'].error).toBe(true);
  });

  it('resolveSummaryErrors is a no-op when the record is not parked', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(chromeMock, makeRecord('notparked', { status: 'done' }));

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'notparked', action: 'retry' },
      {},
    );
    expect(res.ok).toBe(true);
    expect(res.stale).toBe(true);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    await flushMicrotasks();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('resolveSummaryErrors rejects an invalid action', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { dispatchMessage } = await import('./background.js');
    const res = await dispatchMessage(
      { type: 'resolveSummaryErrors', key: 'x', action: 'nope' },
      {},
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid action');
  });

  it('generateRecordSummaries resumes the summarizing stage with summaries forced on', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    // Even with the global toggle still on, the explicit action must win.
    chromeMock.storage.local._store.set('pagetollm-summaries-disabled', true);

    await seedRecord(
      chromeMock,
      makeRecord('gen1', {
        status: 'done',
        contentRevision: 'gen-revision',
        summaryCheckpointContentRevision: 'gen-revision',
        skipSummaries: true,
        summariesDisabled: true,
        summariesIncomplete: true,
        sentences: ['Alpha.', 'Beta.'],
        topics: [{ name: 'Tech>All', sentences: [1, 2] }],
        pipelineRunId: 'old-run',
        acceptedMergeFailurePaths: ['Stale'],
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage({ type: 'generateRecordSummaries', key: 'gen1' }, {});
    expect(res.ok).toBe(true);

    const updated = await readRecord('gen1');
    expect(updated.status).toBe('summarizing');
    expect(updated.skipSummaries).toBe(false);
    expect(updated.pipelineRunId).not.toBe('old-run');
    expect(updated.forceFinalize).toBe(false);
    expect(updated.summaryErrors).toEqual([]);
    expect(updated.acceptedMergeFailurePaths).toEqual([]);
    expect(updated.summariesIncomplete).toBe(false);
    // Topics and sentences are kept so the pipeline resumes instead of reprocessing.
    expect(updated.topics).toHaveLength(1);
    expect(updated.sentences).toEqual(['Alpha.', 'Beta.']);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledWith(
      'gen1',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('generateRecordSummaries rejects a record without stored topics', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(chromeMock, makeRecord('gen2', { status: 'done', topics: [] }));

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage({ type: 'generateRecordSummaries', key: 'gen2' }, {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no topics/i);

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    await flushMicrotasks();
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('generateRecordSummaries refuses a stale checkpoint without mutating it', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('gen-stale-revision', {
        status: 'done',
        contentRevision: 'new-revision',
        summaryCheckpointContentRevision: 'old-revision',
        sentences: ['Old sentence.'],
        topics: [{ name: 'Old', sentences: [1] }],
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    const before = await readRecord('gen-stale-revision');
    await expect(
      dispatchMessage({ type: 'generateRecordSummaries', key: 'gen-stale-revision' }, {}),
    ).resolves.toEqual({
      ok: false,
      error: 'record summary checkpoint is stale — reprocess it instead',
    });

    expect(await readRecord('gen-stale-revision')).toEqual(before);
    expect(updateRecord).not.toHaveBeenCalled();
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('generateRecordSummaries refuses invalid sentence references without mutating the record', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('gen-invalid', {
        status: 'done',
        sentences: ['One.'],
        topics: [{ name: 'A', sentences: [2] }],
        topic_summaries: {
          A: { runs: [{ sentences: [1], text: 'Keep me.' }], source_sentences: [1] },
        },
      }),
    );
    const before = await readRecord('gen-invalid');

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    const result = await dispatchMessage(
      { type: 'generateRecordSummaries', key: 'gen-invalid' },
      {},
    );

    expect(result).toEqual({
      ok: false,
      error: 'record has an incomplete summary checkpoint — reprocess it instead',
    });
    expect(await readRecord('gen-invalid')).toEqual(before);
    expect(updateRecord).not.toHaveBeenCalled();
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it.each(['pending', 'splitting', 'summarizing', 'needs_attention'])(
    'generateRecordSummaries leaves an active %s record alone',
    async (status) => {
      const chromeMock = makeChromeMock();
      vi.stubGlobal('chrome', chromeMock);
      const record = makeRecord(`gen-active-${status}`, {
        status,
        pipelineRunId: 'active-run',
        ...completeSummaryCheckpoint(),
      });
      await seedRecord(chromeMock, record);
      const { dispatchMessage, _resetJobRegistry, backgroundReady } =
        await import('./background.js');
      // Cold-start recovery legitimately resumes in-flight records. Drain and
      // discard that bootstrap activity so this assertion isolates the user
      // action handled below.
      await backgroundReady;
      await drainBootstrapResume();
      _resetJobRegistry();
      const { runPipeline } = await import('./pipeline/orchestrator.js');
      runPipeline.mockClear();
      updateRecord.mockClear();
      const before = await readRecord(record.key);

      await expect(
        dispatchMessage({ type: 'generateRecordSummaries', key: record.key }, {}),
      ).resolves.toEqual({ ok: true, stale: true });
      expect(await readRecord(record.key)).toEqual(before);
      expect(updateRecord).not.toHaveBeenCalled();
      expect(runPipeline).not.toHaveBeenCalled();
    },
  );

  it('generateRecordSummaries treats a CAS-lost terminal record as stale', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('gen-race', {
        status: 'done',
        pipelineRunId: 'old-run',
        ...completeSummaryCheckpoint(),
      }),
    );
    const { dispatchMessage } = await import('./background.js');
    const realUpdate = updateRecord.getMockImplementation();
    updateRecord.mockImplementationOnce(async (key, patch, options) => {
      await realUpdate(key, { pipelineRunId: 'replacement-run' });
      return realUpdate(key, patch, options);
    });

    await expect(
      dispatchMessage({ type: 'generateRecordSummaries', key: 'gen-race' }, {}),
    ).resolves.toEqual({ ok: true, stale: true });
    expect((await readRecord('gen-race')).pipelineRunId).toBe('replacement-run');
    expect((await readRecord('gen-race')).status).toBe('done');
    expect(updateRecord).toHaveBeenLastCalledWith(
      'gen-race',
      expect.any(Object),
      expect.objectContaining({
        expectedPipelineRunId: 'old-run',
        expectedStatuses: ['done', 'cancelled', 'error'],
      }),
    );
  });

  it('reconciles old index projections at service-worker startup', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(chromeMock, makeRecord('old1', { status: 'done', summariesDisabled: true }));
    // Simulate a projection cached by a version predating `summariesDisabled`.
    delete chromeMock.storage.local._store.get('pagetollm:index').meta['old1'].summariesDisabled;

    const { backgroundReady } = await import('./background.js');
    await backgroundReady;

    const { listRecords } = await import('../../core/storage/storage.js');
    const items = await listRecords();
    expect(items.find((i) => i.key === 'old1').summariesDisabled).toBe(true);
  });

  it('captures the global disable-summaries toggle as the run directive on submit', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    chromeMock.storage.local._store.set('pagetollm-summaries-disabled', true);

    const { handleSubmit } = await import('./background.js');
    const result = await handleSubmit({
      html: '<p>fresh page</p>',
      sourceUrl: 'https://example.com/toggle',
    });
    expect(result.ok).toBe(true);

    const rec = await readRecord(result.key);
    expect(rec.skipSummaries).toBe(true);
  });

  it('re-captures the toggle on reprocess so the next run honors the current setting', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    // Record originally ran with summaries disabled; toggle has since been
    // turned back off, so a reprocess should generate summaries again.
    await seedRecord(
      chromeMock,
      makeRecord('reproc-toggle', { status: 'done', skipSummaries: true }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const res = await dispatchMessage({ type: 'reprocessRecord', key: 'reproc-toggle' }, {});
    expect(res.ok).toBe(true);

    const updated = await readRecord('reproc-toggle');
    expect(updated.skipSummaries).toBe(false);
  });

  it('resumes a stale in-flight record', async () => {
    const { worker } = await loadWorker({
      records: [
        makeRecord('stale1', {
          status: 'splitting',
          updatedAt: Date.now() - STALE_MS - 1000,
        }),
      ],
    });
    const { startPipeline, _resetJobRegistry } = worker;
    _resetJobRegistry();

    await startPipeline('stale1');

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(
      'stale1',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('arms the keepalive alarm before the bootstrap read', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(chromeMock, makeRecord('read-fails', { status: 'summarizing' }));

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    chromeMock.alarms.create.mockClear();

    chromeMock.storage.local.get.mockImplementationOnce(() => {
      throw new Error('storage read failed');
    });

    await expect(startPipeline('read-fails')).rejects.toThrow('storage read failed');

    // The caller has already persisted an in-flight status and answered
    // {ok:true}. With no job registered and no alarm, nothing would ever
    // resume this record.
    expect(chromeMock.alarms.create).toHaveBeenCalledWith(
      'pipeline-keepalive',
      expect.objectContaining({ periodInMinutes: expect.any(Number) }),
    );
  });

  it('does not duplicate an already-running job', async () => {
    const { worker } = await loadWorker({
      records: [makeRecord('running1', { status: 'pending' })],
    });
    const { startPipeline, _resetJobRegistry, backgroundReady } = worker;
    // The seeded record is in-flight, so cold-start recovery resumes it too.
    // Let that settle and discard it before counting this test's own starts.
    await backgroundReady;
    await drainBootstrapResume();
    _resetJobRegistry();
    (await import('./pipeline/orchestrator.js')).runPipeline.mockClear();

    // Start a job but do not await its completion.
    const p1 = startPipeline('running1');
    // Immediately try to start again.
    await startPipeline('running1');

    await p1;

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('cancelRecordProcessing aborts the active job and marks the record cancelled', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('cancel1', {
      status: 'summarizing',
      pipelineRunId: 'run-old',
      summariesIncomplete: true,
    });
    await seedRecord(chromeMock, rec);

    const { startPipeline, dispatchMessage, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(() => {
      signalPipelineCall();
      return new Promise((resolve) => {
        resolvePipeline = resolve;
      });
    });

    const running = startPipeline('cancel1');
    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    const oldOptions = runPipeline.mock.calls[0][1];

    const res = await dispatchMessage({ type: 'cancelRecordProcessing', key: 'cancel1' }, {});
    expect(res.ok).toBe(true);
    expect(oldOptions.signal.aborted).toBe(true);

    const stored = await readRecord('cancel1');
    expect(stored.status).toBe('cancelled');
    expect(stored.pipelineRunId).not.toBe('run-old');
    expect(stored.summariesIncomplete).toBe(false);

    resolvePipeline();
    await running;
  });

  it('treats a cancel as stale when the run finalized before its queued write', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('cancel-race', { status: 'summarizing', pipelineRunId: 'run-old' }),
    );

    const { dispatchMessage } = await import('./background.js');
    const realUpdate = updateRecord.getMockImplementation();
    updateRecord.mockImplementationOnce(async (key, patch, options) => {
      // Model the pipeline's finalize write landing after the handler read its
      // snapshot but before the handler reaches storage's serialized update.
      await realUpdate(
        key,
        // Pipeline finalization retains ownership of its run id, which is why
        // the status guard (not just the run-id guard) is needed here.
        { status: 'done', error: null, pipelineRunId: 'run-old' },
        { expectedPipelineRunId: 'run-old' },
      );
      return realUpdate(key, patch, options);
    });

    await expect(
      dispatchMessage({ type: 'cancelRecordProcessing', key: 'cancel-race' }, {}),
    ).resolves.toEqual({ ok: true, stale: true });
    expect((await readRecord('cancel-race')).status).toBe('done');
  });

  it('treats a retry as stale when another writer already took the run', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('retry-race', { pipelineRunId: 'run-old' }));

    const { dispatchMessage } = await import('./background.js');
    const realUpdate = updateRecord.getMockImplementation();
    updateRecord.mockImplementationOnce(async (key, patch, options) => {
      await realUpdate(
        key,
        { status: 'done', error: null, pipelineRunId: 'run-finished' },
        { expectedPipelineRunId: 'run-old' },
      );
      return realUpdate(key, patch, options);
    });

    await expect(dispatchMessage({ type: 'retryRecord', key: 'retry-race' }, {})).resolves.toEqual({
      ok: true,
      stale: true,
    });
    expect((await readRecord('retry-race')).status).toBe('done');
  });

  it('restarts a stale summary checkpoint for new HTML and preserves its summary directive', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    chromeMock.storage.local._store.set('pagetollm-summaries-disabled', false);
    await seedRecord(
      chromeMock,
      makeRecord('retry-stale-summary-checkpoint', {
        ...completeSummaryCheckpoint(),
        contentRevision: 'new-content-revision',
        summaryCheckpointContentRevision: 'old-content-revision',
        html: '<p>Replacement article.</p>',
        status: 'error',
        error: 'pipeline failed before topic computation',
        skipSummaries: true,
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await expect(
      dispatchMessage({ type: 'retryRecord', key: 'retry-stale-summary-checkpoint' }, {}),
    ).resolves.toEqual({ ok: true });

    const retried = await readRecord('retry-stale-summary-checkpoint');
    expect(retried).toMatchObject({
      status: 'pending',
      error: null,
      skipSummaries: true,
      progress: { stage: 'queued', done: 0, total: 0 },
    });
  });

  it('retries a valid errored summary checkpoint without rebuilding it', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    chromeMock.storage.local._store.set('pagetollm-summaries-disabled', true);
    await seedRecord(
      chromeMock,
      makeRecord('retry-summary-checkpoint', {
        ...completeSummaryCheckpoint(),
        status: 'error',
        error: 'late storage write failed',
        summariesIncomplete: true,
        topic_summaries: {
          Checkpoint: {
            runs: [{ sentences: [1, 2], text: 'Already paid for.' }],
            source_sentences: [1, 2],
          },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await expect(
      dispatchMessage({ type: 'retryRecord', key: 'retry-summary-checkpoint' }, {}),
    ).resolves.toEqual({ ok: true });

    const retried = await readRecord('retry-summary-checkpoint');
    expect(retried).toMatchObject({
      status: 'summarizing',
      error: null,
      skipSummaries: false,
      summariesIncomplete: false,
      progress: { stage: 'summarizing_topics', done: 0, total: 1 },
    });
    expect(retried.topic_summaries.Checkpoint).toEqual({
      runs: [{ sentences: [1, 2], text: 'Already paid for.' }],
      source_sentences: [1, 2],
    });
  });

  it('keeps accepted Skip directives when retrying an interrupted summary resume', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('retry-accepted-skip', {
        ...completeSummaryCheckpoint(),
        status: 'error',
        error: 'late index write failed',
        forceFinalize: true,
        acceptedMergeFailurePaths: ['Checkpoint'],
        topic_summaries: {
          Checkpoint: {
            runs: [{ sentences: [1, 2], text: '' }],
            source_sentences: [1, 2],
            acceptedFailure: true,
          },
        },
      }),
    );

    const { dispatchMessage, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await expect(
      dispatchMessage({ type: 'retryRecord', key: 'retry-accepted-skip' }, {}),
    ).resolves.toEqual({ ok: true });

    const retried = await readRecord('retry-accepted-skip');
    expect(retried).toMatchObject({
      status: 'summarizing',
      forceFinalize: true,
      acceptedMergeFailurePaths: ['Checkpoint'],
    });
    expect(retried.topic_summaries.Checkpoint).toEqual({
      runs: [{ sentences: [1, 2], text: '' }],
      source_sentences: [1, 2],
      acceptedFailure: true,
    });
  });

  it('reprocessRecord aborts stale work and starts a fresh run id', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('reprocess1', {
        status: 'summarizing',
        pipelineRunId: 'run-old',
        topics: [{ name: 'Old', sentences: [1] }],
        sentences: ['old'],
        source_summary_units: {
          unit1: { unitId: 'unit1', status: 'done', result: 'cached source summary' },
        },
        acceptedMergeFailurePaths: ['Old'],
        summariesIncomplete: true,
      }),
    );

    const { startPipeline, dispatchMessage, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(() => {
      signalPipelineCall();
      return new Promise((resolve) => {
        resolvePipeline = resolve;
      });
    });

    const running = startPipeline('reprocess1');
    await waitForPipelineCalls(1);
    expect(runPipeline).toHaveBeenCalledTimes(1);
    const oldOptions = runPipeline.mock.calls[0][1];

    const res = await dispatchMessage({ type: 'reprocessRecord', key: 'reprocess1' }, {});
    expect(res.ok).toBe(true);
    expect(oldOptions.signal.aborted).toBe(true);

    await waitForPipelineCalls(2);
    expect(runPipeline).toHaveBeenCalledTimes(2);
    const stored = await readRecord('reprocess1');
    expect(stored.status).toBe('pending');
    expect(stored.pipelineRunId).not.toBe('run-old');
    expect(stored.topics).toEqual([]);
    expect(stored.sentences).toEqual([]);
    expect(stored.source_summary_units).toEqual({});
    expect(stored.acceptedMergeFailurePaths).toEqual([]);
    expect(stored.summariesIncomplete).toBe(false);
    expect(runPipeline.mock.calls[1][1].pipelineRunId).toBe(stored.pipelineRunId);

    resolvePipeline();
    await running;
  });

  it('reprocessRecord treats a CAS-lost replacement as stale without clearing its checkpoint', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('reprocess-race', {
        status: 'error',
        pipelineRunId: 'old-run',
        text: 'Keep this checkpoint.',
        sentences: ['Keep this checkpoint.'],
        topics: [{ name: 'Keep', sentences: [1] }],
      }),
    );
    const { dispatchMessage } = await import('./background.js');
    const realUpdate = updateRecord.getMockImplementation();
    updateRecord.mockImplementationOnce(async (key, patch, options) => {
      await realUpdate(key, { pipelineRunId: 'replacement-run' });
      return realUpdate(key, patch, options);
    });

    await expect(
      dispatchMessage({ type: 'reprocessRecord', key: 'reprocess-race' }, {}),
    ).resolves.toEqual({ ok: true, stale: true });
    const stored = await readRecord('reprocess-race');
    expect(stored).toMatchObject({
      pipelineRunId: 'replacement-run',
      text: 'Keep this checkpoint.',
      sentences: ['Keep this checkpoint.'],
      topics: [{ name: 'Keep', sentences: [1] }],
    });
    expect(updateRecord).toHaveBeenLastCalledWith(
      'reprocess-race',
      expect.any(Object),
      expect.objectContaining({ expectedPipelineRunId: 'old-run', bumpContentRevision: true }),
    );
  });

  it('does not start a job for done records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done2', { status: 'done' });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('done2');

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('reuses an existing record matched by sourceUrl on submit', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { handleSubmit, _resetJobRegistry, backgroundReady } = await import('./background.js');
    await backgroundReady;
    _resetJobRegistry();

    await seedRecord(
      chromeMock,
      makeRecord('url-key', {
        sourceUrl: 'https://example.com/article',
        status: 'pending',
      }),
    );

    const result = await handleSubmit({
      html: '<p>updated body</p>',
      sourceUrl: 'https://example.com/article',
      selectors: ['main'],
    });

    expect(result).toEqual({ ok: true, key: 'url-key' });
    const stored = await readRecord('url-key');
    expect(stored.html).toBe('<p>updated body</p>');
    expect(stored.selectors).toEqual(['main']);
    expect(stored.status).toBe('pending');
  });

  it('clears the prior content checkpoint when resubmitting a non-done URL', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();
    await seedRecord(
      chromeMock,
      makeRecord('url-checkpoint', {
        sourceUrl: 'https://example.com/article-with-checkpoint',
        status: 'error',
        text: 'Old text.',
        sentences: ['Old sentence.'],
        topics: [{ name: 'Old', sentences: [1] }],
        topic_summaries: { Old: { runs: [{ sentences: [1], text: 'Old summary.' }] } },
        topic_summary_index: { Old: { text: 'Old summary.' } },
        source_summary_units: { old: { unitId: 'old', status: 'done' } },
        summaryErrors: [{ topic: 'Old' }],
        summaryCheckpointContentRevision: 'old-revision',
        forceFinalize: true,
        acceptedMergeFailurePaths: ['Old'],
        summariesIncomplete: true,
      }),
    );

    await expect(
      handleSubmit({
        html: '<p>new body</p>',
        sourceUrl: 'https://example.com/article-with-checkpoint',
      }),
    ).resolves.toEqual({ ok: true, key: 'url-checkpoint' });

    const stored = await readRecord('url-checkpoint');
    expect(stored).toMatchObject({
      html: '<p>new body</p>',
      text: '',
      sentences: [],
      topics: [],
      topic_summaries: {},
      topic_summary_index: {},
      source_summary_units: {},
      summaryErrors: [],
      summaryCheckpointContentRevision: null,
      forceFinalize: false,
      acceptedMergeFailurePaths: [],
      summariesIncomplete: false,
    });
  });

  it('does not start a job for error records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('err1', { status: 'error', error: 'boom' });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('err1');

    const { runPipeline } = await import('./pipeline/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe('clearSummaryErrorFlags (pure)', () => {
  it('handles non-object and empty input', async () => {
    const { clearSummaryErrorFlags } = await import('./background.js');
    expect(clearSummaryErrorFlags(null)).toEqual({});
    expect(clearSummaryErrorFlags(undefined)).toEqual({});
    expect(clearSummaryErrorFlags({})).toEqual({});
  });

  it('accepts only explicitly failed runs in a modern checkpoint', async () => {
    const { clearSummaryErrorFlags } = await import('./background.js');
    const out = clearSummaryErrorFlags({
      A: {
        runs: [
          { sentences: [1], text: '' },
          {
            sentences: [5],
            text: '',
            error: true,
            error_kind: 'timeout',
            error_message: 'retry exhausted',
          },
        ],
        source_sentences: [1, 5],
        error: true,
        error_kind: 'timeout',
      },
    });

    expect(out.A).toEqual({
      runs: [
        { sentences: [1], text: '' },
        { sentences: [5], text: '', acceptedFailure: true },
      ],
      source_sentences: [1, 5],
      acceptedFailure: true,
    });
  });
});

describe('background service-worker boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('creates the keepalive alarm only when one does not already exist', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('keepalive-new', { status: 'pending' }));

    const { startPipeline, _resetJobRegistry, backgroundReady } = await import('./background.js');
    // Drain the cold-start resume of the seeded record before clearing: an
    // in-flight bootstrap would otherwise land its own `alarms.create` in the
    // middle of the exact-count assertions below.
    await backgroundReady;
    _resetJobRegistry();
    chromeMock.alarms.create.mockClear();

    await startPipeline('keepalive-new');
    expect(chromeMock.alarms.get).toHaveBeenCalledWith('pipeline-keepalive', expect.any(Function));
    expect(chromeMock.alarms.create).toHaveBeenCalledWith('pipeline-keepalive', {
      periodInMinutes: 0.5,
    });
    // `alarms.create` only accepts (name, alarmInfo); a third (callback)
    // argument makes Chrome reject the call synchronously, so the arity is
    // asserted explicitly — the mock itself accepts any arity.
    expect(chromeMock.alarms.create.mock.calls[0].length).toBe(2);

    await seedRecord(chromeMock, makeRecord('keepalive-existing', { status: 'pending' }));
    chromeMock.alarms.get.mockImplementation((_name, cb) =>
      cb({ name: 'pipeline-keepalive', periodInMinutes: 0.5 }),
    );
    chromeMock.alarms.create.mockClear();
    await startPipeline('keepalive-existing');
    expect(chromeMock.alarms.create).not.toHaveBeenCalled();
  });

  it('warns but still attempts to create the alarm when chrome.alarms.get reports lastError', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('keepalive-get-error', { status: 'pending' }));

    chromeMock.alarms.get.mockImplementation((_name, cb) => {
      chromeMock.runtime.lastError = { message: 'get boom' };
      cb(undefined);
      chromeMock.runtime.lastError = null;
    });

    const { startPipeline, _resetJobRegistry, backgroundReady } = await import('./background.js');
    // See above: settle the bootstrap so this test observes only its own call.
    await backgroundReady;
    _resetJobRegistry();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await startPipeline('keepalive-get-error');
      expect(warnSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: chrome.alarms.get failed:',
        expect.objectContaining({ message: 'get boom' }),
      );
      // A failed get can't be trusted, so bailing out would guarantee no
      // alarm exists (the worst outcome for the sole SW-restart recovery
      // path). alarms.create is idempotent by name, so it must still be
      // attempted.
      expect(chromeMock.alarms.create).toHaveBeenCalledWith('pipeline-keepalive', {
        periodInMinutes: 0.5,
      });
      expect(chromeMock.alarms.create.mock.calls[0].length).toBe(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not throttle ambiguous legacy creates after a get failure', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    // Three distinct records so each `startPipeline` call is a fresh job
    // (the registry dedups repeat calls for the same key) and reaches
    // `scheduleKeepAlive()` independently.
    await seedRecord(chromeMock, makeRecord('keepalive-throttle-a', { status: 'pending' }));
    await seedRecord(chromeMock, makeRecord('keepalive-throttle-b', { status: 'pending' }));
    await seedRecord(chromeMock, makeRecord('keepalive-throttle-c', { status: 'pending' }));

    chromeMock.alarms.get.mockImplementation((_name, cb) => {
      chromeMock.runtime.lastError = { message: 'get boom' };
      cb(undefined);
      chromeMock.runtime.lastError = null;
    });

    const { startPipeline, _resetJobRegistry, backgroundReady } = await import('./background.js');
    // The cold-start bootstrap resumes these seeded in-flight records itself.
    // Let it finish before counting creates, so the counts below belong to the
    // explicit startPipeline calls only.
    await backgroundReady;
    _resetJobRegistry();
    chromeMock.alarms.create.mockClear();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      await startPipeline('keepalive-throttle-a');
      expect(chromeMock.alarms.create).toHaveBeenCalledTimes(1);

      // With a legacy, non-promise create, the get callback's lastError can
      // still be present after create. That does not establish success, so it
      // must not stamp the throttle and suppress the recovery attempt.
      chromeMock.alarms.create.mockClear();
      nowSpy.mockReturnValue(1_000_000 + 1000);
      await startPipeline('keepalive-throttle-b');
      expect(chromeMock.alarms.create).toHaveBeenCalledTimes(1);

      // The same remains true after a full period: every call is attempted
      // until the platform provides an unambiguous success signal.
      chromeMock.alarms.create.mockClear();
      nowSpy.mockReturnValue(1_000_000 + 31_000);
      await startPipeline('keepalive-throttle-c');
      expect(chromeMock.alarms.create).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('warns when chrome.alarms.create reports lastError', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('keepalive-create-error', { status: 'pending' }));

    // Pre-Chrome-111 shape: `create` returns undefined and reports the failure
    // through `runtime.lastError` instead of a rejected promise.
    chromeMock.alarms.create.mockImplementation(() => {
      chromeMock.runtime.lastError = { message: 'create boom' };
      return undefined;
    });

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await startPipeline('keepalive-create-error');
      expect(warnSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: chrome.alarms.create failed:',
        expect.objectContaining({ message: 'create boom' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns when chrome.alarms.create rejects (promise form) or throws', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('keepalive-create-reject', { status: 'pending' }));
    await seedRecord(chromeMock, makeRecord('keepalive-create-throw', { status: 'pending' }));

    // Chrome 111+ returns a promise; a bad signature throws synchronously.
    chromeMock.alarms.create.mockImplementation(() => Promise.reject(new Error('create rejected')));

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await startPipeline('keepalive-create-reject');
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: chrome.alarms.create failed:',
        expect.objectContaining({ message: 'create rejected' }),
      );

      chromeMock.alarms.create.mockImplementation(() => {
        throw new Error('No matching signature');
      });
      await expect(startPipeline('keepalive-create-throw')).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: chrome.alarms.create failed:',
        expect.objectContaining({ message: 'No matching signature' }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('ignores unrelated alarms and clears keepalive when storage has no active records', async () => {
    const { chromeMock } = await loadWorker();
    const alarmListener = chromeMock.alarms.onAlarm.addListener.mock.calls[0][0];

    alarmListener({ name: 'unrelated' });
    await Promise.resolve();
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled();

    alarmListener({ name: 'pipeline-keepalive' });
    await flushMicrotasks();
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('pipeline-keepalive');
  });

  it('clears keepalive from authoritative terminal metadata when its index projection is stale', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('alarm-terminal', { status: 'summarizing' }));

    // Simulate the exact interrupted projection write: the meta document has
    // reached its terminal state but the cached list entry still says it is
    // summarizing. Keepalive must use the authoritative listing and stop.
    const metaKey = 'pagetollm:rec:alarm-terminal:meta';
    chromeMock.storage.local._store.set(metaKey, {
      ...chromeMock.storage.local._store.get(metaKey),
      status: 'done',
      progress: { stage: 'complete', done: 1, total: 1 },
    });

    await import('./background.js');
    const alarmListener = chromeMock.alarms.onAlarm.addListener.mock.calls[0][0];
    alarmListener({ name: 'pipeline-keepalive' });

    await flushMicrotasks();
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('pipeline-keepalive');
    expect(
      chromeMock.storage.local._store.get('pagetollm:index').meta['alarm-terminal'].status,
    ).toBe('done');
  });

  it('resumes every active record when the keepalive alarm fires', async () => {
    const { chromeMock, worker } = await loadWorker({
      records: [
        makeRecord('alarm-a', { status: 'splitting' }),
        makeRecord('alarm-b', { status: 'summarizing' }),
        makeRecord('alarm-done', { status: 'done' }),
      ],
    });

    const { _resetJobRegistry } = worker;
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();
    runPipeline.mockClear();

    const alarmListener = chromeMock.alarms.onAlarm.addListener.mock.calls[0][0];
    alarmListener({ name: 'pipeline-keepalive' });

    await waitForPipelineCalls(2);
    expect(runPipeline.mock.calls.map(([key]) => key).sort()).toEqual(['alarm-a', 'alarm-b']);
    expect(chromeMock.alarms.clear).not.toHaveBeenCalled();
  });

  it('does not produce an unhandled rejection when listRecords fails in the keepalive handler', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await import('./background.js');
    const alarmListener = chromeMock.alarms.onAlarm.addListener.mock.calls[0][0];

    const unhandledRejections = [];
    const onUnhandledRejection = (err) => unhandledRejections.push(err);
    globalThis.process.on('unhandledRejection', onUnhandledRejection);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Fail only the index read `listRecords` performs. `lastError` is reported
    // inside the failing callback and cleared again on the way out, the way
    // Chrome scopes it, so the simulated failure cannot leak into unrelated
    // reads.
    const passThroughGet = chromeMock.storage.local.get.getMockImplementation();
    chromeMock.storage.local.get.mockImplementation((keys, cb) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (!requested.includes('pagetollm:index')) {
        passThroughGet(keys, cb);
        return;
      }
      chromeMock.runtime.lastError = { message: 'boom' };
      cb({});
      chromeMock.runtime.lastError = null;
    });
    try {
      alarmListener({ name: 'pipeline-keepalive' });
      // Let the rejected listRecords() promise and its .catch handler settle.
      // Node emits unhandledRejection at the end of the current event-loop turn,
      // so this one zero-delay timer advances past that reporting point.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandledRejections).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas keepalive listRecords failed:',
        expect.any(Error),
      );
    } finally {
      globalThis.process.off('unhandledRejection', onUnhandledRejection);
      errorSpy.mockRestore();
    }
  });

  it('falls back to an ERROR status write when the pipeline fails and re-logs if that write also fails', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('fallback1', { status: 'summarizing' }));

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();
    updateRecord.mockClear();

    // Simulate a pipeline failure that reaches startPipeline's catch (as it
    // would if orchestrator's own error-status write also failed and rethrew).
    runPipeline.mockImplementationOnce(() => Promise.reject(new Error('pipeline boom')));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startPipeline('fallback1');
      expect(updateRecord).toHaveBeenCalledWith(
        'fallback1',
        expect.objectContaining({
          status: 'error',
          error: expect.stringContaining('pipeline boom'),
        }),
        { expectedPipelineRunId: undefined },
      );
      const stored = await readRecord('fallback1');
      expect(stored.status).toBe('error');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('logs (and does not throw) when both the pipeline and the fallback status write fail', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('fallback2', { status: 'summarizing' }));

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();
    updateRecord.mockClear();

    runPipeline.mockImplementationOnce(() => Promise.reject(new Error('pipeline boom')));
    updateRecord.mockRejectedValueOnce(new Error('storage boom'));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await startPipeline('fallback2');
      expect(errorSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: fallback error-status write also failed for',
        'fallback2',
        expect.any(Error),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('does not let a superseded run clobber a newer run when the fallback write races a resubmit', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('fallback3', { status: 'summarizing', pipelineRunId: 'run-A' }),
    );

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    _resetJobRegistry();
    updateRecord.mockClear();

    // Run A's pipeline stalls so a resubmit (run B) can take ownership of the
    // record before A's failure is handled.
    let rejectRunA;
    runPipeline.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRunA = reject;
        }),
    );

    const running = startPipeline('fallback3');
    // Let startPipeline read the record and capture pipelineRunId 'run-A'.
    await Promise.resolve();
    await Promise.resolve();

    // A newer run now owns the record (e.g. the user resubmitted).
    await updateRecord('fallback3', { status: 'splitting', pipelineRunId: 'run-B' });
    updateRecord.mockClear();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      rejectRunA(new Error('pipeline boom'));
      await running;
      expect(updateRecord).toHaveBeenCalledWith(
        'fallback3',
        expect.objectContaining({ status: 'error' }),
        { expectedPipelineRunId: 'run-A' },
      );
      expect(warnSpy).toHaveBeenCalledWith(
        'PageToLLM Canvas: fallback error-status write skipped (record superseded) for',
        'fallback3',
      );
      // The fallback's guarded write must not have overwritten run B's state.
      expect(errorSpy).not.toHaveBeenCalledWith(
        'PageToLLM Canvas: fallback error-status write also failed for',
        expect.anything(),
        expect.anything(),
      );

      const stored = await readRecord('fallback3');
      expect(stored.status).toBe('splitting');
      expect(stored.pipelineRunId).toBe('run-B');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('does nothing on startup when the record list has no active work', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(chromeMock, makeRecord('startup-done', { status: 'done' }));

    const { backgroundReady } = await import('./background.js');
    await backgroundReady;
    const { runPipeline } = await import('./pipeline/orchestrator.js');
    runPipeline.mockClear();
    chromeMock.alarms.get.mockClear();
    chromeMock.alarms.clear.mockClear();
    chromeMock.runtime.onStartup.addListener.mock.calls[0][0]();
    await flushMicrotasks();
    expect(chromeMock.alarms.clear).toHaveBeenCalledWith('pipeline-keepalive');

    expect(runPipeline).not.toHaveBeenCalled();
    expect(chromeMock.alarms.get).not.toHaveBeenCalled();
  });
});

describe('record import and submission boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadDispatch(chromeMock) {
    vi.stubGlobal('chrome', chromeMock);
    const { dispatchMessage } = await import('./background.js');
    return (msg) =>
      dispatchMessage(msg, { id: 'test-id', url: 'chrome-extension://test-id/options.html' });
  }

  it.each([undefined, null, '', false, 0])(
    'rejects an empty submission html value: %j',
    async (html) => {
      const chromeMock = makeChromeMock();
      vi.stubGlobal('chrome', chromeMock);
      const { handleSubmit } = await import('./background.js');

      await expect(handleSubmit({ html })).resolves.toEqual({ ok: false, error: 'missing html' });
    },
  );

  it('persists all observable defaults for a fresh submission', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result = await handleSubmit({ html: '<main>defaults</main>', selectors: 'main' });
    const stored = await readRecord(result.key);

    expect(result).toEqual({ ok: true, key: expect.stringMatching(/^[a-f0-9]{32}$/) });
    expect(stored).toMatchObject({
      key: result.key,
      sourceUrl: '',
      html: '<main>defaults</main>',
      text: '',
      status: 'pending',
      error: null,
      progress: { stage: 'queued', done: 0, total: 0 },
      sentences: [],
      topics: [],
      topic_summaries: {},
      topic_summary_index: {},
      processingLog: [],
      selectors: [],
      skipSummaries: false,
    });
    expect(stored.pipelineRunId).toEqual(expect.any(String));
    expect(stored.pipelineRunId.length).toBeGreaterThan(0);
    expect(stored.createdAt).toEqual(expect.any(Number));
    expect(stored.updatedAt).toBe(stored.createdAt);
  });

  it('uses a deterministic non-UUID fallback when randomUUID is unavailable', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { subtle: originalCrypto.subtle });
    vi.spyOn(Date, 'now').mockReturnValue(36);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const { handleSubmit } = await import('./background.js');
    const result = await handleSubmit({ html: '<p>fallback id</p>' });
    const stored = await readRecord(result.key);

    expect(stored.pipelineRunId).toBe('10-i');
    vi.restoreAllMocks();
    vi.stubGlobal('crypto', originalCrypto);
  });

  it('rejects non-array and empty import payloads', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatch(chromeMock);

    for (const records of [undefined, null, {}, 'records', []]) {
      await expect(dispatch({ type: 'importRecords', records })).resolves.toEqual({
        ok: false,
        error: 'no records to import',
      });
    }
  });

  it('accepts canonical records with HTML and rejects incomplete records', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatch(chromeMock);
    const records = [
      { key: ' html ', html: '<p>article</p>' },
      { key: 'empty-html', html: '' },
      { key: 'text', text: '' },
      { key: 'sentences', sentences: [] },
      { key: 'topics', topics: [] },
      { key: 'summaries', topic_summaries: {} },
      null,
      'record',
      {},
      { key: 123, text: 'x' },
      { key: '   ', text: 'x' },
      { key: 'metadata-only', sourceUrl: 'https://example.com' },
    ];

    await expect(dispatch({ type: 'importRecords', records })).resolves.toEqual({
      ok: true,
      count: 1,
    });
    expect(await readRecord('html')).toMatchObject({ key: 'html', html: '<p>article</p>' });
    expect(await readRecord('empty-html')).toBeNull();
    expect(await readRecord('text')).toBeNull();
    expect(await readRecord('sentences')).toBeNull();
    expect(await readRecord('topics')).toBeNull();
    expect(await readRecord('summaries')).toBeNull();
    expect(await readRecord('metadata-only')).toBeNull();
  });

  it('normalizes imported status, error, and progress without discarding valid progress fields', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatch(chromeMock);

    await expect(
      dispatch({
        type: 'importRecords',
        records: [
          {
            key: 'active',
            html: '<p>x</p>',
            text: 'x',
            status: 'summarizing',
            error: 'old failure',
            progress: { detail: 'kept', stage: 'old', done: 9, total: 10 },
          },
          {
            key: 'failed',
            html: '<p>x</p>',
            text: 'x',
            status: 'error',
            error: 'kept failure',
            progress: null,
          },
          { key: 'nostatus', html: '<p>x</p>', text: 'x', status: '', error: 'discarded' },
        ],
      }),
    ).resolves.toEqual({ ok: true, count: 3 });

    expect(await readRecord('active')).toMatchObject({
      status: 'done',
      error: null,
      progress: { detail: 'kept', stage: 'imported', done: 1, total: 1 },
    });
    expect(await readRecord('failed')).toMatchObject({
      status: 'error',
      error: 'kept failure',
      progress: { stage: 'imported', done: 1, total: 1 },
    });
    expect(await readRecord('nostatus')).toMatchObject({
      status: 'done',
      error: null,
      progress: { stage: 'imported', done: 1, total: 1 },
    });
  });

  it('distinguishes every missing topics/sentences prerequisite for summary generation', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatch(chromeMock);
    const cases = [
      {
        record: makeRecord('topics-not-array', { status: 'done', topics: null, sentences: ['x'] }),
        error: 'record has no topics yet — reprocess it instead',
      },
      {
        record: makeRecord('topics-empty', { status: 'done', topics: [], sentences: ['x'] }),
        error: 'record has no topics yet — reprocess it instead',
      },
      {
        record: makeRecord('sentences-not-array', {
          status: 'done',
          topics: [{ name: 'A' }],
          sentences: null,
        }),
        error: 'record has an incomplete summary checkpoint — reprocess it instead',
      },
      {
        record: makeRecord('sentences-empty', {
          status: 'done',
          topics: [{ name: 'A' }],
          sentences: [],
        }),
        error: 'record has an incomplete summary checkpoint — reprocess it instead',
      },
    ];
    for (const { record } of cases) await seedRecord(chromeMock, record);

    for (const { record, error } of cases) {
      await expect(dispatch({ type: 'generateRecordSummaries', key: record.key })).resolves.toEqual(
        {
          ok: false,
          error,
        },
      );
    }
  });

  it('returns precise results for missing and already-finished cancellation targets', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatch(chromeMock);
    await seedRecord(chromeMock, makeRecord('already-done', { status: 'done' }));

    await expect(dispatch({ type: 'cancelRecordProcessing', key: 'missing' })).resolves.toEqual({
      ok: false,
      error: 'record not found',
    });
    await expect(
      dispatch({ type: 'cancelRecordProcessing', key: 'already-done' }),
    ).resolves.toEqual({ ok: true, stale: true });
    expect((await readRecord('already-done')).status).toBe('done');
  });
});
