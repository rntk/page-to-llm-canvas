import { describe, it, expect, beforeEach, vi } from 'vitest';

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
  };
}

function seedRecord(chromeMock, rec) {
  const sKey = `pagetollm:rec:${rec.key}`;
  chromeMock.storage.local._store.set(sKey, rec);
  const idx = chromeMock.storage.local._store.get('pagetollm:index') || { keys: [] };
  if (!idx.keys.includes(rec.key)) idx.keys.unshift(rec.key);
  chromeMock.storage.local._store.set('pagetollm:index', idx);
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

  it('summarizes idle action icon state', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./background.js');

    expect(summarizeProcessingState([{ status: 'done' }, { status: 'error' }])).toEqual({
      active: false,
      count: 0,
      ratio: 0,
    });
  });

  it('treats a parked (needs_attention) record as not in-flight', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./background.js');

    // The "won't auto-resume" invariant for needs_attention rests entirely on it
    // staying out of IN_FLIGHT_STATUSES; pin that so adding it back would fail here.
    expect(
      summarizeProcessingState([
        { status: 'needs_attention', progress: { stage: 'needs_attention', done: 1, total: 2 } },
      ]),
    ).toEqual({ active: false, count: 0, ratio: 0 });
  });

  it('summarizes indeterminate action icon state for queued work', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./background.js');
    const state = summarizeProcessingState([
      { status: 'pending', progress: { stage: 'queued', done: 0, total: 0 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(1);
    expect(state.ratio).toBeGreaterThan(0);
    expect(state.ratio).toBeLessThan(1);
  });

  it('summarizes determinate action icon progress across in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./background.js');
    const state = summarizeProcessingState([
      { status: 'summarizing', progress: { stage: 'summarizing_topics', done: 2, total: 4 } },
      { status: 'splitting', progress: { stage: 'topic_ranges', done: 3, total: 6 } },
      { status: 'done', progress: { stage: 'done', done: 1, total: 1 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(2);
    expect(state.ratio).toBeCloseTo(0.5);
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
    expect(runPipeline).toHaveBeenCalledWith(result.key);
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
    seedRecord(chromeMock, rec);

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

    seedRecord(
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

    const updated = chromeMock.storage.local._store.get('pagetollm:rec:park1');
    expect(updated.status).toBe('summarizing');
    expect(updated.forceFinalize).toBe(false);
    expect(updated.summaryErrors).toEqual([]);
    // Retry keeps the flag so the resumed run re-queries only the failed leaf.
    expect(updated.topic_summaries['Tech>All'].error).toBe(true);

    await new Promise((r) => setTimeout(r, 30));
    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledWith('park1');
  });

  it('resolveSummaryErrors skip clears leaf error flags and forces finalize', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    seedRecord(
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

    const updated = chromeMock.storage.local._store.get('pagetollm:rec:park2');
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

    seedRecord(chromeMock, makeRecord('notparked', { status: 'done' }));

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

  it('resumes a stale in-flight record', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('stale1', {
      status: 'splitting',
      updatedAt: Date.now() - STALE_MS - 1000,
    });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('stale1');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith('stale1');
  });

  it('does not duplicate an already-running job', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('running1', { status: 'pending' });
    seedRecord(chromeMock, rec);

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

  it('does not start a job for done records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('done2', { status: 'done' });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('done2');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it('does not start a job for error records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const rec = makeRecord('err1', { status: 'error', error: 'boom' });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import('./background.js');
    _resetJobRegistry();

    await startPipeline('err1');

    const { runPipeline } = await import('./worker/orchestrator.js');
    expect(runPipeline).not.toHaveBeenCalled();
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
    expect(res).toEqual({ ok: true, type: 'echo', from: 'chrome-extension://test-id/options.html' });
  });

  it('uses MESSAGE_HANDLERS registry by default (smoke test)', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const res = await dispatchMessage({ type: 'listRecords' }, {});
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.items)).toBe(true);
  });
});
