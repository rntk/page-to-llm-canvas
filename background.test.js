import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readRecord, writeRecord } from './worker/storage.js';

vi.mock('./worker/orchestrator.js', () => ({
  runPipeline: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10))),
}));

const STALE_MS = 10 * 60 * 1000;

function makeChromeMock() {
  const store = new Map();
  const runtime = { lastError: null };

  const chromeLocal = {
    _store: store,
    get: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      runtime.lastError = null;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb();
    }),
    remove: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
      cb();
    }),
  };

  return {
    storage: {
      local: chromeLocal,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      ...runtime,
      getURL: vi.fn((path = '') => `chrome-extension://test-id/${path}`),
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
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

// Records are physically split across `:meta`/`:content`/`:summaries` docs
// (see worker/storage.js); seeding/reading a record for a test goes through
// the same writeRecord/readRecord functions background.js itself uses,
// rather than poking the mock store directly. Requires `chrome` to already
// be stubbed to `chromeMock` (writeRecord/readRecord read the global).
async function seedRecord(chromeMock, rec) {
  await writeRecord(rec);
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

describe('background pipeline lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('updates the toolbar badge and progress icon for in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('busy1', {
        status: 'summarizing',
        progress: { stage: 'summarizing_topics', done: 1, total: 2 },
      }),
    );
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        constructor(w, h) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage: vi.fn(),
            fillStyle: '',
            beginPath: vi.fn(),
            roundRect: vi.fn(),
            fill: vi.fn(),
            getImageData: () => ({ data: new Uint8ClampedArray(4) }),
          };
        }
      },
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({})),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        blob: async () => new Blob(),
      })),
    );

    await import('./background.js');
    // vi.waitFor only retries while its callback throws — a callback that
    // merely returns a boolean (the previous form here) resolves on its very
    // first tick regardless of the value, so it never actually waited for the
    // async badge update. Assert (which throws on failure) so it genuinely
    // polls until the badge call lands.
    await vi.waitFor(() => {
      expect(chromeMock.action.setBadgeText.mock.calls.length).toBeGreaterThan(0);
    });

    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '...' });
    vi.unstubAllGlobals();
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

    const { runPipeline } = await import('./worker/orchestrator.js');
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

    const { runPipeline } = await import('./worker/orchestrator.js');
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

  it('does not start duplicate jobs for the same key', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result1 = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });
    const result2 = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });

    expect(result1.key).toBe(result2.key);

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('returns existing done record without restarting', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done1', { status: 'done', updatedAt: Date.now() });
    await seedRecord(chromeMock, rec);

    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    const result = await handleSubmit({
      html: '<p>hello</p>',
      sourceUrl: 'https://example.com',
    });

    expect(result.ok).toBe(true);
    expect(result.key).toBe('done1');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('resolveSummaryErrors retry resumes the pipeline and keeps leaf error flags', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park1', {
        status: 'needs_attention',
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
    // Retry keeps the flag so the resumed run re-queries only the failed leaf.
    expect(updated.topic_summaries['Tech>All'].error).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledWith(
      'park1',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('resolveSummaryErrors skip clears leaf error flags and forces finalize', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('park2', {
        status: 'needs_attention',
        summaryErrors: [{ topic: 'Tech>All', error_kind: 'timeout', error_message: 'x' }],
        topic_summaries: {
          'Tech>All': {
            text: '',
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
    expect(leaf.text).toBe('');
    expect(leaf.source_sentences).toEqual([1]);
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

    await new Promise((r) => setTimeout(r, 30));
    const { runPipeline } = await import('./worker/orchestrator.js');
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
        skipSummaries: true,
        summariesDisabled: true,
        sentences: ['Alpha.', 'Beta.'],
        topics: [{ name: 'Tech>All', sentences: [1, 2], sentence_spans: [], ranges: [] }],
        pipelineRunId: 'old-run',
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
    // Topics and sentences are kept so the pipeline resumes instead of reprocessing.
    expect(updated.topics).toHaveLength(1);
    expect(updated.sentences).toEqual(['Alpha.', 'Beta.']);

    await new Promise((r) => setTimeout(r, 30));
    const { runPipeline } = await import('./worker/orchestrator.js');
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

    await new Promise((r) => setTimeout(r, 30));
    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('backfills old index projections at service-worker startup', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(chromeMock, makeRecord('old1', { status: 'done', summariesDisabled: true }));
    // Simulate a projection cached by a version predating `summariesDisabled`.
    delete chromeMock.storage.local._store.get('pagetollm:index').meta['old1'].summariesDisabled;

    await import('./background.js');
    await new Promise((r) => setTimeout(r, 30));

    const { listRecords } = await import('./worker/storage.js');
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
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('stale1', {
      status: 'splitting',
      updatedAt: Date.now() - STALE_MS - 1000,
    });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('stale1');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(
      'stale1',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('aborts a stale registered job before restarting it', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    await seedRecord(
      chromeMock,
      makeRecord('stale-running', {
        status: 'summarizing',
        pipelineRunId: 'run-same',
        updatedAt: Date.now(),
      }),
    );

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./worker/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );

    const first = startPipeline('stale-running');
    await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    const oldOptions = runPipeline.mock.calls[0][1];

    const metaKey = 'pagetollm:rec:stale-running:meta';
    const meta = chromeMock.storage.local._store.get(metaKey);
    chromeMock.storage.local._store.set(metaKey, {
      ...meta,
      updatedAt: Date.now() - STALE_MS - 1000,
    });

    await startPipeline('stale-running');

    expect(oldOptions.signal.aborted).toBe(true);
    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(runPipeline.mock.calls[1][1].pipelineRunId).toBe('run-same');

    resolvePipeline();
    await first;
  });

  it('does not duplicate an already-running job', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('running1', { status: 'pending' });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    // Start a job but do not await its completion.
    const p1 = startPipeline('running1');
    // Immediately try to start again.
    await startPipeline('running1');

    await p1;

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it('cancelRecordProcessing aborts the active job and marks the record cancelled', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('cancel1', {
      status: 'summarizing',
      pipelineRunId: 'run-old',
    });
    await seedRecord(chromeMock, rec);

    const { startPipeline, dispatchMessage, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./worker/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );

    const running = startPipeline('cancel1');
    await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    const oldOptions = runPipeline.mock.calls[0][1];

    const res = await dispatchMessage({ type: 'cancelRecordProcessing', key: 'cancel1' }, {});
    expect(res.ok).toBe(true);
    expect(oldOptions.signal.aborted).toBe(true);

    const stored = await readRecord('cancel1');
    expect(stored.status).toBe('cancelled');
    expect(stored.pipelineRunId).not.toBe('run-old');

    resolvePipeline();
    await running;
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
      }),
    );

    const { startPipeline, dispatchMessage, _resetJobRegistry } = await import('./background.js');
    const { runPipeline } = await import('./worker/orchestrator.js');
    _resetJobRegistry();

    let resolvePipeline;
    runPipeline.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePipeline = resolve;
        }),
    );

    const running = startPipeline('reprocess1');
    await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(1));
    const oldOptions = runPipeline.mock.calls[0][1];

    const res = await dispatchMessage({ type: 'reprocessRecord', key: 'reprocess1' }, {});
    expect(res.ok).toBe(true);
    expect(oldOptions.signal.aborted).toBe(true);

    await vi.waitFor(() => expect(runPipeline).toHaveBeenCalledTimes(2));
    const stored = await readRecord('reprocess1');
    expect(stored.status).toBe('pending');
    expect(stored.pipelineRunId).not.toBe('run-old');
    expect(stored.topics).toEqual([]);
    expect(stored.sentences).toEqual([]);
    expect(runPipeline.mock.calls[1][1].pipelineRunId).toBe(stored.pipelineRunId);

    resolvePipeline();
    await running;
  });

  it('does not start a job for done records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done2', { status: 'done' });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('done2');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('reuses an existing record matched by sourceUrl on submit', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { handleSubmit, _resetJobRegistry } = await import('./background.js');
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

  it('does not start a job for error records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('err1', { status: 'error', error: 'boom' });
    await seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('err1');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe('clearSummaryErrorFlags (pure)', () => {
  it('strips error markers from topic summaries while preserving other fields', async () => {
    const { clearSummaryErrorFlags } = await import('./background.js');
    const input = {
      'A>B': {
        text: 't',
        source_sentences: [1],
        error: true,
        error_kind: 'timeout',
        error_message: 'x',
        error_detail: 'y',
        other: 42,
      },
      C: { text: 'ok', source_sentences: [3] },
      bad: null,
    };
    const out = clearSummaryErrorFlags(input);
    expect(out).toEqual({
      'A>B': { text: 't', source_sentences: [1], other: 42 },
      C: { text: 'ok', source_sentences: [3] },
      bad: null,
    });
  });

  it('handles non-object and empty input', async () => {
    const { clearSummaryErrorFlags } = await import('./background.js');
    expect(clearSummaryErrorFlags(null)).toEqual({});
    expect(clearSummaryErrorFlags(undefined)).toEqual({});
    expect(clearSummaryErrorFlags({})).toEqual({});
  });
});

describe('provider message handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadDispatcher(chromeMock) {
    vi.stubGlobal('chrome', chromeMock);
    await import('./background.js');
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
    return (msg, sender = { url: 'chrome-extension://test-id/options.html' }) =>
      new Promise((resolve) => {
        const returned = listener(msg, sender, resolve);
        expect(returned).toBe(true);
      });
  }

  it('saveProvider stores a provider and makes it active', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    const res = await dispatch({
      type: 'saveProvider',
      provider: { type: 'openai', name: 'OpenAI', model: 'gpt-4o', token: 'k' },
    });

    expect(res.ok).toBe(true);
    expect(res.providers).toHaveLength(1);
    expect(res.activeId).toBe(res.provider.id);
    expect(res.provider.token).toBeUndefined();
    expect(res.provider.hasToken).toBe(true);
    expect(res.providers[0].token).toBeUndefined();
    expect(chromeMock.storage.local._store.get('pagetollm:llm:providers').providers).toHaveLength(
      1,
    );
  });

  it('listProviders returns the stored state', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    await dispatch({
      type: 'saveProvider',
      provider: { type: 'anthropic', name: 'Claude', model: 'claude-haiku-4-5', token: 'k' },
    });
    const res = await dispatch({ type: 'listProviders' });
    expect(res.ok).toBe(true);
    expect(res.providers[0].name).toBe('Claude');
    expect(res.providers[0].token).toBeUndefined();
    expect(res.providers[0].hasToken).toBe(true);
    expect(res.activeId).toBe(res.providers[0].id);
  });

  it('setActiveProvider switches the active provider', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    const a = await dispatch({
      type: 'saveProvider',
      provider: { type: 'openai', name: 'A', model: 'm', token: 'k' },
    });
    const b = await dispatch({
      type: 'saveProvider',
      provider: { type: 'anthropic', name: 'B', model: 'claude-haiku-4-5', token: 'k' },
    });
    const res = await dispatch({ type: 'setActiveProvider', id: b.provider.id });
    expect(res.ok).toBe(true);
    expect(res.activeId).toBe(b.provider.id);
    expect(a.provider.id).not.toBe(b.provider.id);
  });

  it('deleteProvider removes a provider', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    const a = await dispatch({
      type: 'saveProvider',
      provider: { type: 'openai', name: 'A', model: 'm', token: 'k' },
    });
    const res = await dispatch({ type: 'deleteProvider', id: a.provider.id });
    expect(res.ok).toBe(true);
    expect(res.providers).toHaveLength(0);
    expect(res.activeId).toBeNull();
  });

  it('saveProvider rejects invalid input with an error response', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    const res = await dispatch({ type: 'saveProvider', provider: { type: 'openai', name: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/model/);
  });

  it('deleteProvider and setActiveProvider validate missing id', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    expect((await dispatch({ type: 'deleteProvider' })).error).toBe('missing id');
    expect((await dispatch({ type: 'setActiveProvider' })).error).toBe('missing id');
  });

  it('rejects provider management messages from non-extension pages', async () => {
    const chromeMock = makeChromeMock();
    const dispatch = await loadDispatcher(chromeMock);

    const res = await dispatch({ type: 'listProviders' }, { url: 'https://example.com/page' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/extension pages/);
  });
});

describe('dispatchMessage unit tests', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadDispatchMessage(chromeMock) {
    vi.stubGlobal('chrome', chromeMock);
    const { dispatchMessage } = await import('./background.js');
    return dispatchMessage;
  }

  it('returns unknown-type error for unregistered type', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {};
    const res = await dispatchMessage({ type: 'nope' }, {}, fakeHandlers);
    expect(res).toEqual({ ok: false, error: 'unknown type: nope' });
  });

  it('returns validation error when validate returns a string', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      doThing: {
        requiresExtensionPage: false,
        validate: () => 'missing key',
        handle: vi.fn(async () => ({ ok: true })),
      },
    };
    const res = await dispatchMessage({ type: 'doThing' }, {}, fakeHandlers);
    expect(res).toEqual({ ok: false, error: 'missing key' });
    expect(fakeHandlers.doThing.handle).not.toHaveBeenCalled();
  });

  it('blocks extension-page-gated handlers from non-extension senders', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      secret: {
        requiresExtensionPage: true,
        validate: () => null,
        handle: vi.fn(async () => ({ ok: true })),
      },
    };
    const res = await dispatchMessage(
      { type: 'secret' },
      { url: 'https://example.com/page' },
      fakeHandlers,
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/extension pages/);
    expect(fakeHandlers.secret.handle).not.toHaveBeenCalled();
  });

  it('allows extension-page-gated handlers from extension senders', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      secret: {
        requiresExtensionPage: true,
        validate: () => null,
        handle: vi.fn(async () => ({ ok: true, data: 42 })),
      },
    };
    const res = await dispatchMessage(
      { type: 'secret' },
      { url: 'chrome-extension://test-id/options.html' },
      fakeHandlers,
    );
    expect(res).toEqual({ ok: true, data: 42 });
    expect(fakeHandlers.secret.handle).toHaveBeenCalledTimes(1);
  });

  it('wraps handler exceptions into { ok: false, error } response', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      boom: {
        requiresExtensionPage: false,
        validate: () => null,
        handle: vi.fn(async () => {
          throw new Error('something went wrong');
        }),
      },
    };
    const res = await dispatchMessage({ type: 'boom' }, {}, fakeHandlers);
    expect(res).toEqual({ ok: false, error: 'something went wrong' });
  });

  it('returns handler result on success', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      ping: {
        requiresExtensionPage: false,
        validate: () => null,
        handle: vi.fn(async (_msg, _sender) => ({ ok: true, pong: true })),
      },
    };
    const msg = { type: 'ping' };
    const sender = { url: 'chrome-extension://test-id/popup.html' };
    const res = await dispatchMessage(msg, sender, fakeHandlers);
    expect(res).toEqual({ ok: true, pong: true });
    expect(fakeHandlers.ping.handle).toHaveBeenCalledWith(msg, sender);
  });

  it('passes msg and sender to handler', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {
      echo: {
        requiresExtensionPage: false,
        validate: () => null,
        handle: vi.fn(async (msg, sender) => ({ ok: true, type: msg.type, from: sender.url })),
      },
    };
    const res = await dispatchMessage(
      { type: 'echo' },
      { url: 'chrome-extension://test-id/options.html' },
      fakeHandlers,
    );
    expect(res).toEqual({
      ok: true,
      type: 'echo',
      from: 'chrome-extension://test-id/options.html',
    });
  });

  it('uses MESSAGE_HANDLERS registry by default (smoke test)', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const res = await dispatchMessage({ type: 'listRecords' }, {});
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.items)).toBe(true);
  });

  it('handles retryRecord, reprocessRecord, getRecord, deleteRecord, and deleteAll', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    await seedRecord(chromeMock, makeRecord('rec1', { status: 'error' }));

    expect((await dispatchMessage({ type: 'retryRecord' })).error).toBe('missing key');
    expect((await dispatchMessage({ type: 'retryRecord', key: 'missing' })).error).toBe(
      'record not found',
    );

    const retry = await dispatchMessage({ type: 'retryRecord', key: 'rec1' });
    expect(retry.ok).toBe(true);

    const reprocess = await dispatchMessage({ type: 'reprocessRecord', key: 'rec1' });
    expect(reprocess.ok).toBe(true);
    const reprocessed = await readRecord('rec1');
    expect(reprocessed.topics).toEqual([]);
    expect(reprocessed.sentences).toEqual([]);

    const got = await dispatchMessage({ type: 'getRecord', key: 'rec1' });
    expect(got.ok).toBe(true);
    expect(got.record.key).toBe('rec1');

    const missing = await dispatchMessage({ type: 'getRecord', key: 'nope' });
    expect(missing.ok).toBe(false);

    const createdChat = await dispatchMessage({ type: 'createChat', key: 'rec1' });
    expect(createdChat.ok).toBe(true);
    const chatId = createdChat.chat.chatId;
    expect(
      (
        await dispatchMessage({
          type: 'appendChatMessage',
          key: 'rec1',
          chatId,
          message: { role: 'user', content: 'Question' },
        })
      ).ok,
    ).toBe(true);
    const appendedEvent = await dispatchMessage({
      type: 'appendChatEvent',
      key: 'rec1',
      chatId,
      event: {
        eventType: 'highlight_span',
        data: { startLine: 1, endLine: 1 },
      },
    });
    expect(appendedEvent.ok).toBe(true);
    expect((await dispatchMessage({ type: 'listChats', key: 'rec1' })).chats).toHaveLength(1);
    expect(
      (await dispatchMessage({ type: 'getChat', key: 'rec1', chatId })).chat.events,
    ).toHaveLength(1);
    expect(
      (
        await dispatchMessage({
          type: 'deleteChatEvent',
          key: 'rec1',
          chatId,
          seq: appendedEvent.event.seq,
        })
      ).ok,
    ).toBe(true);
    expect((await dispatchMessage({ type: 'deleteChat', key: 'rec1', chatId })).ok).toBe(true);

    const deleted = await dispatchMessage({ type: 'deleteRecord', key: 'rec1' });
    expect(deleted.ok).toBe(true);
    expect(await readRecord('rec1')).toBeNull();

    await seedRecord(chromeMock, makeRecord('rec2'));
    await seedRecord(chromeMock, makeRecord('rec3'));
    const cleared = await dispatchMessage({ type: 'deleteAll' });
    expect(cleared.ok).toBe(true);
    const index = chromeMock.storage.local._store.get('pagetollm:index');
    expect(index == null || index.keys?.length === 0).toBe(true);
  });

  it('imports only valid records, dedupes duplicate keys, and reports the stored count', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { url: 'chrome-extension://test-id/options.html' };

    const res = await dispatchMessage(
      {
        type: 'importRecords',
        records: [
          { key: 'dup', text: 'old' },
          { key: 'metadata-only', sourceUrl: 'https://example.com' },
          { key: 'dup', text: 'new' },
        ],
      },
      sender,
    );

    expect(res).toEqual({ ok: true, count: 1 });
    const stored = await readRecord('dup');
    expect(stored.text).toBe('new');
    expect(await readRecord('metadata-only')).toBeNull();
  });

  it('rejects import batches with no importable records', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { url: 'chrome-extension://test-id/options.html' };

    const res = await dispatchMessage(
      { type: 'importRecords', records: [{ key: 'empty', sourceUrl: 'https://example.com' }] },
      sender,
    );

    expect(res).toEqual({ ok: false, error: 'no valid records to import' });
    expect(await readRecord('empty')).toBeNull();
  });

  it('imports records with a fresh pipelineRunId so stale pipeline writes cannot match', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { url: 'chrome-extension://test-id/options.html' };

    await seedRecord(
      chromeMock,
      makeRecord('imported', {
        status: 'summarizing',
        pipelineRunId: 'run-old',
      }),
    );

    const res = await dispatchMessage(
      {
        type: 'importRecords',
        records: [
          {
            key: 'imported',
            text: 'imported text',
            status: 'summarizing',
            pipelineRunId: 'run-old',
          },
        ],
      },
      sender,
    );

    expect(res).toEqual({ ok: true, count: 1 });
    const stored = await readRecord('imported');
    expect(stored.status).toBe('done');
    expect(stored.text).toBe('imported text');
    expect(stored.pipelineRunId).not.toBe('run-old');
    expect(stored.progress).toEqual({ stage: 'imported', done: 1, total: 1 });
  });

  it('validates ensurePipeline and llmChatCompletion inputs', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    expect((await dispatchMessage({ type: 'ensurePipeline' })).error).toBe('missing key');

    const llm = await dispatchMessage({ type: 'llmChatCompletion', prompt: '' });
    expect(llm.ok).toBe(false);
    expect(llm.error).toBe('missing prompt or messages');
  });
});
