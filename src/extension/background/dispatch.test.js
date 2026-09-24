import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readRecord, writeRecord } from '../../core/storage/storage.js';
import { LLM_METRICS_KEY } from '../../core/metrics/llm.js';
import { CHAT_TOOL_METRICS_KEY } from '../../core/metrics/chatTool.js';
import { PARSER_METRICS_KEY } from '../../core/metrics/parser.js';
import { RESPLIT_METRICS_KEY } from '../../core/metrics/resplit.js';
import { createChromeStorageFake } from '../../../test/fakes/chromeStorageFake.mjs';

const mockedRunPipeline = vi.hoisted(() =>
  vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10))),
);
vi.mock('./pipeline/orchestrator.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    runPipeline: mockedRunPipeline,
    createPipelineRunner: vi.fn(() => ({ runPipeline: mockedRunPipeline, dispose: vi.fn() })),
  };
});

function makeChromeMock() {
  const storageFake = createChromeStorageFake();
  const runtime = Object.assign(storageFake.runtime, {
    id: 'test-id',
    getURL: vi.fn((path = '') => 'chrome-extension://test-id/' + path),
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  });
  return {
    storage: {
      local: storageFake.storage.local,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime,
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      get: vi.fn((_name, cb) => cb(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setIcon: vi.fn() },
  };
}
async function seedRecord(_chromeMock, record) {
  await writeRecord(record);
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

describe('provider message handlers', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  async function loadDispatcher(chromeMock) {
    vi.stubGlobal('chrome', chromeMock);
    await import('./background.js');
    const listener = chromeMock.runtime.onMessage.addListener.mock.calls[0][0];
    return (msg, sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' }) =>
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
    return (
      msg,
      sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' },
      handlers,
    ) => dispatchMessage(msg, sender, handlers);
  }

  it('returns unknown-type error for unregistered type', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {};
    const res = await dispatchMessage({ type: 'nope' }, {}, fakeHandlers);
    expect(res).toEqual({ ok: false, error: 'unknown type: nope' });
  });

  it('treats inherited Object.prototype keys as unknown types instead of rejecting', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const fakeHandlers = {};
    await expect(dispatchMessage({ type: '__proto__' }, {}, fakeHandlers)).resolves.toEqual({
      ok: false,
      error: 'unknown type: __proto__',
    });
    await expect(dispatchMessage({ type: 'constructor' }, {}, fakeHandlers)).resolves.toEqual({
      ok: false,
      error: 'unknown type: constructor',
    });
    await expect(dispatchMessage({ type: 'toString' }, {}, fakeHandlers)).resolves.toEqual({
      ok: false,
      error: 'unknown type: toString',
    });
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
      { id: 'test-id', url: 'chrome-extension://test-id/options.html' },
      fakeHandlers,
    );
    expect(res).toEqual({ ok: true, data: 42 });
    expect(fakeHandlers.secret.handle).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    {},
    { url: 'chrome-extension://test-id/options.html' },
    { id: 'other-id', url: 'chrome-extension://test-id/options.html' },
    { id: 'test-id', url: 'https://example.com/page', tab: { id: 1 } },
    { id: 'test-id', url: 'chrome-extension://other-id/options.html' },
    { id: 'test-id', url: 'chrome-extension://test-id/modal.html?key=private' },
    { id: 'test-id', url: 'chrome-extension://test-id/options.html/extra' },
    { id: 'test-id', url: 'chrome-extension://test-id/options.html.evil' },
    { id: 'test-id', url: 'invalid url' },
  ])('rejects privileged actions for untrusted sender %j', async (sender) => {
    vi.stubGlobal('chrome', makeChromeMock());
    const { dispatchMessage } = await import('./background.js');
    for (const type of [
      'getRecord',
      'listRecords',
      'deleteRecord',
      'deleteAll',
      'importRecords',
      'clearParserMetrics',
      'clearResplitMetrics',
      'clearChatToolMetrics',
      'listProviders',
      'saveProvider',
      'deleteProvider',
      'setActiveProvider',
      'getStorageOverview',
      'deleteAllExtensionData',
    ]) {
      await expect(dispatchMessage({ type, key: 'private' }, sender)).resolves.toEqual({
        ok: false,
        error: 'this action is only available to trusted extension pages',
      });
    }
    const entry = { requiresExtensionPage: true, validate: vi.fn(), handle: vi.fn() };
    await dispatchMessage({ type: 'secret' }, sender, { secret: entry });
    expect(entry.validate).not.toHaveBeenCalled();
    expect(entry.handle).not.toHaveBeenCalled();
  });

  it.each(['options.html', 'popup.html', 'options.html?section=data#records'])(
    'allows management from %s',
    async (page) => {
      const dispatchMessage = await loadDispatchMessage(makeChromeMock());
      const sender = { id: 'test-id', url: 'chrome-extension://test-id/' + page };
      expect((await dispatchMessage({ type: 'listRecords' }, sender)).ok).toBe(true);
      expect((await dispatchMessage({ type: 'clearParserMetrics' }, sender)).ok).toBe(true);
      expect((await dispatchMessage({ type: 'deleteAll' }, sender)).ok).toBe(true);
    },
  );

  it.each(['https://example.com/article', 'chrome-extension://test-id/modal.html?key=viewable'])(
    'keeps the record view available to %s',
    async (url) => {
      const chromeMock = makeChromeMock();
      const dispatchMessage = await loadDispatchMessage(chromeMock);
      await seedRecord(chromeMock, makeRecord('viewable'));
      const response = await dispatchMessage(
        { type: 'getRecordView', key: 'viewable' },
        { id: 'test-id', url },
      );
      expect(response.ok).toBe(true);
      expect(response.record.key).toBe('viewable');
    },
  );

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
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/popup.html' };
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
      { id: 'test-id', url: 'chrome-extension://test-id/options.html' },
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

    const res = await dispatchMessage({ type: 'listRecords' });
    expect(res.ok).toBe(true);
    expect(Array.isArray(res.items)).toBe(true);
  });

  it('handles retryRecord, reprocessRecord, getRecord, deleteRecord, and deleteAll', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    await seedRecord(
      chromeMock,
      makeRecord('rec1', { status: 'error', acceptedMergeFailurePaths: ['Stale'] }),
    );

    expect((await dispatchMessage({ type: 'retryRecord' })).error).toBe('missing key');
    expect((await dispatchMessage({ type: 'retryRecord', key: 'missing' })).error).toBe(
      'record not found',
    );

    const retry = await dispatchMessage({ type: 'retryRecord', key: 'rec1' });
    expect(retry.ok).toBe(true);
    expect((await readRecord('rec1')).acceptedMergeFailurePaths).toEqual([]);

    const reprocess = await dispatchMessage({ type: 'reprocessRecord', key: 'rec1' });
    expect(reprocess.ok).toBe(true);
    const reprocessed = await readRecord('rec1');
    expect(reprocessed.topics).toEqual([]);
    expect(reprocessed.sentences).toEqual([]);
    expect(reprocessed.source_summary_units).toEqual({});

    const got = await dispatchMessage({ type: 'getRecord', key: 'rec1' });
    expect(got.ok).toBe(true);
    expect(got.record.key).toBe('rec1');

    const missing = await dispatchMessage({ type: 'getRecord', key: 'nope' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe('record not found');

    const createdChat = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'rec1',
      turn: {
        messages: [{ role: 'user', content: 'Question' }],
        events: [{ eventType: 'highlight_span', data: { startLine: 1, endLine: 1 } }],
      },
    });
    expect(createdChat.ok).toBe(true);
    const chatId = createdChat.chat.chatId;
    expect((await dispatchMessage({ type: 'listChats', key: 'rec1' })).chats).toHaveLength(1);
    expect(
      (await dispatchMessage({ type: 'getChat', key: 'rec1', chatId })).chat.events,
    ).toHaveLength(1);
    expect((await dispatchMessage({ type: 'deleteChat', key: 'rec1', chatId })).ok).toBe(true);
    // Event history is read-only and is removed only with its owning chat.
    expect((await dispatchMessage({ type: 'getChat', key: 'rec1', chatId })).ok).toBe(false);

    const deleted = await dispatchMessage({ type: 'deleteRecord', key: 'rec1' });
    expect(deleted.ok).toBe(true);
    expect(await readRecord('rec1')).toBeNull();

    await seedRecord(chromeMock, makeRecord('rec2'));
    await seedRecord(chromeMock, makeRecord('rec3'));
    const cleared = await dispatchMessage({ type: 'deleteAll' });
    expect(cleared.ok).toBe(true);
    const index = chromeMock.storage.local._store.get('pagetollm:index');
    expect(index?.keys ?? []).toEqual([]);
  });

  it('reports storage categories and removes all extension data, including legacy keys', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    await seedRecord(chromeMock, makeRecord('rec1', { status: 'done' }));
    chromeMock.storage.local._store.set('pagetollm:llm:providers', {
      providers: [{ id: 'provider', token: 'secret' }],
      activeId: 'provider',
    });
    chromeMock.storage.local._store.set('legacy-unknown-key', { old: true });
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };

    const inspected = await dispatchMessage({ type: 'getStorageOverview' }, sender);
    expect(inspected.ok).toBe(true);
    expect(inspected.overview.categories.pageData.recordCount).toBe(1);
    expect(inspected.overview.categories.providers.providerCount).toBe(1);
    expect(inspected.overview.categories.other.keyCount).toBe(1);
    expect(JSON.stringify(inspected)).not.toContain('secret');

    const reset = await dispatchMessage({ type: 'deleteAllExtensionData' }, sender);
    expect(reset.ok).toBe(true);
    expect(chromeMock.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(chromeMock.storage.local._store.size).toBe(0);
  });

  it('still clears all extension data when a preliminary metric clear fails', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    chromeMock.storage.local._store.set('legacy-unknown-key', { old: true });
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };

    // The first preliminary clear is LLM metrics. Its rejected write must not
    // skip the authoritative storage.local.clear() that follows all queues.
    chromeMock.storage.local.set.mockImplementationOnce((_items, callback) => {
      chromeMock.runtime.lastError = { message: 'metric clear unavailable' };
      callback();
      chromeMock.runtime.lastError = null;
    });

    const reset = await dispatchMessage({ type: 'deleteAllExtensionData' }, sender);

    expect(reset).toEqual({ ok: true });
    expect(chromeMock.storage.local.clear).toHaveBeenCalledTimes(1);
    expect(chromeMock.storage.local._store.size).toBe(0);
  });

  it('handles appendChatTurn: validates input, creates the chat inline, and returns the turn', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    await seedRecord(chromeMock, makeRecord('rec1'));

    expect((await dispatchMessage({ type: 'appendChatTurn' })).error).toBe('missing key');
    expect((await dispatchMessage({ type: 'appendChatTurn', key: 'rec1' })).error).toBe(
      'missing turn',
    );
    expect(
      (
        await dispatchMessage({
          type: 'appendChatTurn',
          key: 'rec1',
          turn: { messages: [], events: [] },
        })
      ).error,
    ).toBe('empty turn');
    expect(
      (
        await dispatchMessage({
          type: 'appendChatTurn',
          key: 'rec1',
          chatId: 'other:chat_alias',
          turn: { messages: [{ role: 'user', content: 'unsafe' }] },
        })
      ).error,
    ).toBe('invalid chatId');

    // chatId is optional: a falsy chatId creates the chat inline.
    const first = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'rec1',
      turn: {
        messages: [
          { role: 'user', content: 'Where is it?' },
          { role: 'assistant', content: 'On line 2.' },
        ],
        events: [{ eventType: 'highlight_span', data: { startLine: 2, endLine: 2 } }],
      },
    });
    expect(first.ok).toBe(true);
    expect(first.chat.chatId).toMatch(/^chat_/);
    expect(first.chat.title).toBe('Where is it?');
    expect(first.chat.messages).toHaveLength(2);
    expect(first.chat.events).toHaveLength(1);
    expect(first.chat.events[0].seq).toBe(1);

    const second = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'rec1',
      chatId: first.chat.chatId,
      turn: { events: [{ eventType: 'highlight_span', data: { startLine: 3, endLine: 3 } }] },
    });
    expect(second.ok).toBe(true);
    expect(second.chat.events.at(-1).seq).toBe(2);
    expect(second.chat.messages).toHaveLength(2);

    const missingChat = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'rec1',
      chatId: 'chat_missing',
      turn: { messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(missingChat).toEqual({ ok: false, error: 'chat not found' });
  });

  it('imports only valid records, dedupes duplicate keys, and reports the stored count', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };

    const res = await dispatchMessage(
      {
        type: 'importRecords',
        records: [
          { key: 'dup', html: '<p>old</p>', text: 'old' },
          { key: 'metadata-only', sourceUrl: 'https://example.com' },
          { key: 'empty-html', html: '' },
          {
            key: 'invalid-summary-index',
            html: '<p>invalid summary index</p>',
            topic_summary_index: { Topic: { runs: [] } },
          },
          { key: 'dup', html: '<p>new</p>', text: 'new' },
        ],
      },
      sender,
    );

    expect(res).toEqual({ ok: true, count: 1 });
    const stored = await readRecord('dup');
    expect(stored.text).toBe('new');
    expect(await readRecord('metadata-only')).toBeNull();
    expect(await readRecord('empty-html')).toBeNull();
    expect(await readRecord('invalid-summary-index')).toBeNull();
  });

  it('archives chat history when an import replaces record content', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };
    await seedRecord(chromeMock, makeRecord('replace-me', { text: 'old content' }));
    const created = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'replace-me',
      turn: { turnId: 'old-turn', messages: [{ role: 'user', content: 'Old question' }] },
    });
    expect(created.ok).toBe(true);

    await dispatchMessage(
      {
        type: 'importRecords',
        records: [{ key: 'replace-me', html: '<p>new content</p>', text: 'new content' }],
      },
      sender,
    );

    expect((await dispatchMessage({ type: 'listChats', key: 'replace-me' })).chats).toEqual([]);
    expect(
      (await dispatchMessage({ type: 'getChat', key: 'replace-me', chatId: created.chat.chatId }))
        .ok,
    ).toBe(false);
  });

  // A rail loads the record once and answers from that snapshot. If the record
  // is replaced meanwhile, the turn's first append carries no chatId, so only
  // the caller's expected revision can stop it from being stored as a chat of
  // the new content.
  it('refuses a first turn whose source revision was replaced by an import', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };
    await seedRecord(chromeMock, makeRecord('replace-me', { text: 'old content' }));
    const loaded = await dispatchMessage({ type: 'getRecordView', key: 'replace-me' });
    const staleRevision = loaded.record.contentRevision;
    expect(typeof staleRevision).toBe('string');

    expect(
      (
        await dispatchMessage({
          type: 'appendChatTurn',
          key: 'replace-me',
          contentRevision: 42,
          turn: { messages: [{ role: 'user', content: 'Question' }] },
        })
      ).error,
    ).toBe('invalid contentRevision');

    await dispatchMessage(
      {
        type: 'importRecords',
        records: [{ key: 'replace-me', html: '<p>new content</p>', text: 'new content' }],
      },
      sender,
    );

    const stale = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'replace-me',
      contentRevision: staleRevision,
      turn: { messages: [{ role: 'user', content: 'Question about the old content' }] },
    });

    expect(stale).toEqual({ ok: true, stale: true });
    expect((await dispatchMessage({ type: 'listChats', key: 'replace-me' })).chats).toEqual([]);

    // The same turn against the current revision is still accepted.
    const current = (await dispatchMessage({ type: 'getRecordView', key: 'replace-me' })).record
      .contentRevision;
    const fresh = await dispatchMessage({
      type: 'appendChatTurn',
      key: 'replace-me',
      contentRevision: current,
      turn: { messages: [{ role: 'user', content: 'Question about the new content' }] },
    });
    expect(fresh.ok).toBe(true);
    expect(fresh.chat.contentRevision).toBe(current);
  });

  it('rejects import batches with no importable records', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };

    const res = await dispatchMessage(
      { type: 'importRecords', records: [{ key: 'empty', sourceUrl: 'https://example.com' }] },
      sender,
    );

    expect(res).toEqual({ ok: false, error: 'no valid records to import' });
    expect(await readRecord('empty')).toBeNull();
  });

  it('keeps earlier records and reports their count when the second write fails', async () => {
    const chromeMock = makeChromeMock();
    const originalSet = chromeMock.storage.local.set;
    chromeMock.storage.local.set = vi.fn((items, callback) => {
      if (Object.keys(items).some((key) => key.includes('second-import'))) {
        chromeMock.runtime.lastError = { message: 'storage full' };
        callback();
        chromeMock.runtime.lastError = null;
        return;
      }
      originalSet(items, callback);
    });
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const result = await dispatchMessage({
      type: 'importRecords',
      records: [
        { key: 'first-import', html: '<p>first</p>' },
        { key: 'second-import', html: '<p>second</p>' },
        { key: 'third-import', html: '<p>third</p>' },
      ],
    });

    expect(result).toEqual({ ok: false, count: 1, error: 'storage full' });
    expect(await readRecord('first-import')).toMatchObject({ html: '<p>first</p>' });
    expect(await readRecord('second-import')).toBeNull();
    expect(await readRecord('third-import')).toBeNull();
  });

  it('imports records with a fresh pipelineRunId so stale pipeline writes cannot match', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };

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
            html: '<p>imported text</p>',
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

  it('validates llmChatCompletion inputs', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const llm = await dispatchMessage({ type: 'llmChatCompletion', prompt: '' });
    expect(llm.ok).toBe(false);
    expect(llm.error).toBe('missing prompt or messages');
  });

  it('records an LLM metric for chat completions, tagged by task type', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    // No provider is configured, so callLLMDirectWithRetry returns a failure — but the
    // handler must still record a metric so failed chat calls stay visible.
    const res = await dispatchMessage({
      type: 'llmChatCompletion',
      prompt: 'hello',
      taskType: 'chat_answer',
    });
    expect(res.ok).toBe(false);

    // recordLlmMetric is fire-and-forget; wait for the store write to land.
    await vi.waitFor(() => {
      expect(chromeMock.storage.local._store.has(LLM_METRICS_KEY)).toBe(true);
    });
    const metrics = chromeMock.storage.local._store.get(LLM_METRICS_KEY);
    expect(metrics.totalCount).toBe(1);
    expect(metrics.failureCount).toBe(1);
    expect(metrics.byTaskType.chat_answer?.totalCount).toBe(1);
    expect(metrics.recent[0]).toMatchObject({ ok: false, taskType: 'chat_answer' });
  });

  it('cancels every in-flight provider request belonging to a chat turn', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    const sender = { id: 'test-id', url: 'chrome-extension://test-id/options.html' };
    await dispatchMessage(
      {
        type: 'saveProvider',
        provider: { type: 'openai', name: 'OpenAI', model: 'gpt-4o-mini', token: 'secret' },
      },
      sender,
    );
    const abortedSignals = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                abortedSignals.push(init.signal);
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          }),
      ),
    );

    const first = dispatchMessage({
      type: 'llmChatCompletion',
      prompt: 'first',
      chatTurnId: 'turn-cancel',
    });
    const second = dispatchMessage({
      type: 'llmChatCompletion',
      prompt: 'second',
      chatTurnId: 'turn-cancel',
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    expect(await dispatchMessage({ type: 'cancelChatTurn', turnId: 'turn-cancel' })).toEqual({
      ok: true,
    });
    const results = await Promise.all([first, second]);
    expect(results.every((result) => result.ok === false && /aborted/i.test(result.error))).toBe(
      true,
    );
    expect(abortedSignals).toHaveLength(2);
  });

  it('records a chat tool-call outcome metric', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    const res = await dispatchMessage({
      type: 'recordChatToolMetric',
      outcome: 'out_of_range',
      error: 'line range must be between 1 and 4',
    });
    expect(res).toEqual({ ok: true });

    // Handler awaits the write, so the store is populated by the time it returns.
    const metrics = chromeMock.storage.local._store.get(CHAT_TOOL_METRICS_KEY);
    expect(metrics.totalCount).toBe(1);
    expect(metrics.errorCount).toBe(1);
    expect(metrics.byOutcome.out_of_range).toBe(1);
    expect(metrics.recent[0]).toMatchObject({ outcome: 'out_of_range' });
  });

  it('clears chat tool-call metrics through the worker', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);

    await dispatchMessage({ type: 'recordChatToolMetric', outcome: 'highlighted' });
    expect(chromeMock.storage.local._store.get(CHAT_TOOL_METRICS_KEY).totalCount).toBe(1);

    const res = await dispatchMessage({ type: 'clearChatToolMetrics' });
    expect(res).toEqual({ ok: true });
    expect(chromeMock.storage.local._store.get(CHAT_TOOL_METRICS_KEY).totalCount).toBe(0);
  });

  it('clears parser and resplit metrics through the worker', async () => {
    const chromeMock = makeChromeMock();
    const dispatchMessage = await loadDispatchMessage(chromeMock);
    chromeMock.storage.local._store.set(PARSER_METRICS_KEY, { totalCount: 3 });
    chromeMock.storage.local._store.set(RESPLIT_METRICS_KEY, { runCount: 4 });

    await expect(dispatchMessage({ type: 'clearParserMetrics' })).resolves.toEqual({ ok: true });
    await expect(dispatchMessage({ type: 'clearResplitMetrics' })).resolves.toEqual({ ok: true });

    expect(chromeMock.storage.local._store.get(PARSER_METRICS_KEY).totalCount).toBe(0);
    expect(chromeMock.storage.local._store.get(RESPLIT_METRICS_KEY).runCount).toBe(0);
  });
});
