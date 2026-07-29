import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatHistory,
  reconcileChatStorage,
  MAX_CHAT_TURNS,
} from './chatStorage.js';
import {
  writeRecord,
  updateRecord,
  deleteRecord,
  deleteAll,
  INDEX_KEY,
  _resetUpdateQueues,
} from './storage.js';

const originalCrypto = globalThis.crypto;

// ---------------------------------------------------------------------------
// Chrome mock helpers (mirrors worker/storage.test.js)
// ---------------------------------------------------------------------------

/**
 * Builds a minimal in-memory chrome.storage.local mock.
 *
 * @param {{ lastErrorOnSet?: boolean, lastErrorOnGet?: boolean,
 *            lastErrorOnRemove?: boolean }} [opts]
 */
function makeChromeMock(opts = {}) {
  // Kept as a live (mutable) object, rather than destructured consts, so
  // tests can seed data first and flip a failure flag on afterwards.
  const state = {
    lastErrorOnSet: false,
    lastErrorOnGet: false,
    lastErrorOnRemove: false,
    ...opts,
  };
  const store = new Map();
  const runtime = { lastError: null };

  const chromeLocal = {
    _store: store,
    getKeys: vi.fn((cb) => {
      runtime.lastError = null;
      cb([...store.keys()]);
    }),
    get: vi.fn((keys, cb) => {
      if (state.lastErrorOnGet) {
        runtime.lastError = { message: 'get failed' };
        cb({});
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      const result = {};
      const keyList =
        keys === null || keys === undefined
          ? [...store.keys()]
          : Array.isArray(keys)
            ? keys
            : [keys];
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      if (state.lastErrorOnSet) {
        runtime.lastError = { message: 'QuotaExceededError' };
        cb();
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb();
    }),
    remove: vi.fn((keys, cb) => {
      if (state.lastErrorOnRemove) {
        runtime.lastError = { message: 'remove failed' };
        cb();
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
      cb();
    }),
  };

  return { storage: { local: chromeLocal }, runtime, _state: state };
}

/** Seeds a record into the mock store (via writeRecord) so tests start with known data. */
async function seedRecord(chromeMock, rec) {
  await writeRecord(rec);
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>hello</p>',
    text: 'hello',
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

// ---------------------------------------------------------------------------
// Setup: install chrome global before each test, reset queue state
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetUpdateQueues();
});

// ---------------------------------------------------------------------------
// Per-chat history and events (moved from worker/storage.test.js)
// ---------------------------------------------------------------------------

describe('per-chat history and events', () => {
  // 'persists messages and events under one chat and updates its summary' is
  // covered by the appendChatTurn describe block below (same assertions:
  // hidden messages excluded from messageCount, events included in
  // eventCount, title derived from the first visible user message).

  it('isolates read-only events by chat and removes them with chat deletion', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat: first } = await appendChatTurn('article', null, {
      events: [{ eventType: 'highlight_span', data: { startLine: 1, endLine: 1 } }],
    });
    const { chat: second } = await appendChatTurn('article', null, {
      events: [{ eventType: 'highlight_span', data: { startLine: 4, endLine: 4 } }],
    });

    expect((await readChat('article', first.chatId)).events).toHaveLength(1);
    expect((await readChat('article', second.chatId)).events).toHaveLength(1);
    expect(first.events[0].seq).toBe(1);
    expect((await readChat('article', second.chatId)).events).toHaveLength(1);
    expect(await deleteChatHistory('article', second.chatId)).toBe(true);
    expect(await readChat('article', second.chatId)).toBeNull();
  });

  it('keeps a chat discoverable when document removal fails so deletion can be retried', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      turnId: 'delete-retry-turn',
      messages: [{ role: 'user', content: 'Delete me' }],
    });
    const documentKey = `pagetollm:chats:article:${chat.chatId}`;

    mock._state.lastErrorOnRemove = true;
    await expect(deleteChatHistory('article', chat.chatId)).rejects.toThrow('remove failed');

    mock._state.lastErrorOnRemove = false;
    expect(mock.storage.local._store.has(documentKey)).toBe(true);
    expect(await listChats('article')).toEqual([expect.objectContaining({ chatId: chat.chatId })]);

    await expect(deleteChatHistory('article', chat.chatId)).resolves.toBe(true);
    expect(mock.storage.local._store.has(documentKey)).toBe(false);
    expect(await listChats('article')).toEqual([]);
  });

  it('treats deletion of an already-absent chat as an idempotent success', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Delete me once' }],
    });

    await expect(deleteChatHistory('article', chat.chatId)).resolves.toBe(true);
    await expect(deleteChatHistory('article', chat.chatId)).resolves.toBe(true);
    await expect(deleteChatHistory('article', 'chat_never_existed')).resolves.toBe(true);
  });

  it('does not let a colon-delimited chat id address another record document', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('a'));
    await seedRecord(mock, makeRecord('a:b'));
    const { chat } = await appendChatTurn('a:b', null, {
      messages: [{ role: 'user', content: 'Belongs to a:b' }],
    });
    const aliasedChatId = `b:${chat.chatId}`;

    expect(await readChat('a', aliasedChatId)).toBeNull();
    await expect(
      appendChatTurn('a', aliasedChatId, {
        messages: [{ role: 'user', content: 'Must not cross records' }],
      }),
    ).rejects.toThrow('chat not found');
    await expect(deleteChatHistory('a', aliasedChatId)).resolves.toBe(true);

    expect(await readChat('a:b', chat.chatId)).not.toBeNull();
  });

  it('removes the empty chat index after deleting the final chat', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'The only chat' }],
    });
    const indexKey = 'pagetollm:chats:article:index';

    expect(mock.storage.local._store.has(indexKey)).toBe(true);
    await deleteChatHistory('article', chat.chatId);
    expect(mock.storage.local._store.has(indexKey)).toBe(false);
  });

  it('removes all chat documents when the record is deleted, including unindexed orphans', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Question' }],
    });
    const documentKey = `pagetollm:chats:article:${chat.chatId}`;
    mock.storage.local._store.set('pagetollm:chats:article:index', {
      chats: [],
      turns: [],
    });

    await deleteRecord('article');

    expect(await listChats('article')).toEqual([]);
    expect(await readChat('article', chat.chatId)).toBeNull();
    expect(mock.storage.local._store.has(documentKey)).toBe(false);
  });

  it('removes all chat documents when all records are deleted, including unindexed orphans', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Question' }],
    });
    const documentKey = `pagetollm:chats:article:${chat.chatId}`;
    mock.storage.local._store.set('pagetollm:chats:article:index', {
      chats: [],
      turns: [],
    });

    await deleteAll();

    expect(await listChats('article')).toEqual([]);
    expect(await readChat('article', chat.chatId)).toBeNull();
    expect(mock.storage.local._store.has(documentKey)).toBe(false);
  });

  it('deletes nothing when a chat-index read fails during deleteAll', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Question' }],
    });

    // Fail the chat-index read during deleteAll's read phase; every other read
    // (INDEX_KEY, etc.) still works, so the record docs are gathered first.
    const realGet = mock.storage.local.get.getMockImplementation();
    mock.storage.local.get.mockImplementation((keys, cb) => {
      const keyList = Array.isArray(keys) ? keys : [keys];
      if (keyList.includes('pagetollm:chats:article:index')) {
        mock.runtime.lastError = { message: 'get failed' };
        cb({});
        mock.runtime.lastError = null;
        return;
      }
      realGet(keys, cb);
    });

    await expect(deleteAll()).rejects.toThrow('get failed');

    // Reads-first invariant: the failure aborted before any removeLocal, so the
    // index, record meta doc, and chat doc are all still present.
    mock.storage.local.get.mockImplementation(realGet);
    expect(mock.storage.local._store.has(INDEX_KEY)).toBe(true);
    expect(mock.storage.local._store.has('pagetollm:rec:article:meta')).toBe(true);
    expect(await readChat('article', chat.chatId)).not.toBeNull();
  });

  // 'createChat refuses to create a chat for a missing record' is covered by
  // the appendChatTurn describe block's 'throws record not found when
  // creating a chat for a missing record'.
});

// ---------------------------------------------------------------------------
// Durable cleanup and repair
// ---------------------------------------------------------------------------

describe('reconcileChatStorage', () => {
  it('repairs valid orphan documents and removes stale or dangling storage', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      turnId: 'turn-indexed',
      messages: [{ role: 'user', content: 'Indexed chat' }],
    });

    const store = mock.storage.local._store;
    const indexKey = 'pagetollm:chats:article:index';
    const contentRevision = store.get('pagetollm:rec:article:meta').contentRevision;
    const orphan = {
      ...chat,
      chatId: 'chat_valid_orphan',
      title: 'Recovered chat',
      createdAt: chat.createdAt + 1,
      updatedAt: chat.updatedAt + 1,
      messages: [
        {
          ...chat.messages[0],
          id: 'message_valid_orphan',
          content: 'Recovered chat',
          turnId: 'turn-valid-orphan',
        },
      ],
      turnIds: ['turn-valid-orphan'],
    };
    const stale = {
      ...orphan,
      chatId: 'chat_stale_revision',
      contentRevision: 'rev_superseded',
    };
    const recordless = {
      ...orphan,
      chatId: 'chat_recordless',
      contentRevision,
    };
    store.set('pagetollm:chats:article:chat_valid_orphan', orphan);
    store.set('pagetollm:chats:article:chat_stale_revision', stale);
    store.set('pagetollm:chats:missing:chat_recordless', recordless);

    const index = store.get(indexKey);
    index.chats.push(
      {
        chatId: stale.chatId,
        title: stale.title,
        createdAt: stale.createdAt,
        updatedAt: stale.updatedAt,
        messageCount: 1,
        eventCount: 0,
        contentRevision: stale.contentRevision,
      },
      {
        chatId: 'chat_missing_document',
        title: 'Dangling summary',
        createdAt: 1,
        updatedAt: 1,
        messageCount: 1,
        eventCount: 0,
        contentRevision,
      },
    );
    index.turns.push(
      { turnId: 'turn-stale', chatId: stale.chatId },
      { turnId: 'turn-missing', chatId: 'chat_missing_document' },
    );

    await reconcileChatStorage();

    expect(store.has('pagetollm:chats:article:chat_stale_revision')).toBe(false);
    expect(store.has('pagetollm:chats:missing:chat_recordless')).toBe(false);
    expect(store.get('pagetollm:chats:article:chat_valid_orphan')).toEqual(orphan);

    const repaired = store.get(indexKey);
    expect(repaired.chats.map((summary) => summary.chatId).sort()).toEqual(
      [chat.chatId, orphan.chatId].sort(),
    );
    expect(repaired.chats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chatId: orphan.chatId,
          title: orphan.title,
          messageCount: 1,
          eventCount: 0,
          contentRevision,
        }),
      ]),
    );
    expect([...repaired.turns].sort((a, b) => a.turnId.localeCompare(b.turnId))).toEqual(
      [
        { turnId: 'turn-indexed', chatId: chat.chatId },
        { turnId: 'turn-valid-orphan', chatId: orphan.chatId },
      ].sort((a, b) => a.turnId.localeCompare(b.turnId)),
    );
  });

  it('finishes stale-revision cleanup after the original prune remove fails', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      turnId: 'turn-before-revision',
      messages: [{ role: 'user', content: 'Old revision' }],
    });
    const documentKey = `pagetollm:chats:article:${chat.chatId}`;
    const indexKey = 'pagetollm:chats:article:index';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mock._state.lastErrorOnRemove = true;
    await updateRecord('article', { text: 'replacement' }, { bumpContentRevision: true });
    mock._state.lastErrorOnRemove = false;

    expect(warn).toHaveBeenCalledWith(
      'PageToLLM Canvas: stale chat cleanup failed:',
      expect.objectContaining({ message: 'remove failed' }),
    );
    expect(mock.storage.local._store.has(documentKey)).toBe(true);

    await reconcileChatStorage();

    expect(mock.storage.local._store.has(documentKey)).toBe(false);
    expect(mock.storage.local._store.has(indexKey)).toBe(false);
    expect(await listChats('article')).toEqual([]);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// titleIsDefault — placeholder-title lifecycle
// ---------------------------------------------------------------------------

describe('titleIsDefault behavior', () => {
  it('marks a fresh chat as default-titled and clears the flag on first visible user message', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    // Seed the chat with an event only, so it starts out title-less.
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 0, endLine: 0 } }],
    });
    expect(chat.title).toBe('New chat');
    expect(chat.titleIsDefault).toBe(true);

    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: 'First question' }],
    });
    const stored = await readChat('article', chat.chatId);
    expect(stored.title).toBe('First question');
    expect(stored.titleIsDefault).toBe(false);

    // Later user messages must not re-derive the title.
    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: 'Second question' }],
    });
    expect((await readChat('article', chat.chatId)).title).toBe('First question');
  });

  it('keeps the placeholder derivable across hidden or blank user messages', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'hidden context', hidden: true }],
    });
    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: '   ' }],
    });
    let stored = await readChat('article', chat.chatId);
    expect(stored.title).toBe('New chat');
    expect(stored.titleIsDefault).toBe(true);

    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: 'Real question' }],
    });
    stored = await readChat('article', chat.chatId);
    expect(stored.title).toBe('Real question');
    expect(stored.titleIsDefault).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// appendChatTurn — atomic whole-turn persistence
// ---------------------------------------------------------------------------

describe('appendChatTurn', () => {
  it('uses crypto.randomUUID ids when the browser provides them', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce('turn-uuid')
      .mockReturnValueOnce('chat-uuid')
      .mockReturnValueOnce('message-uuid');
    vi.stubGlobal('crypto', { randomUUID });

    try {
      const { chat } = await appendChatTurn('article', null, {
        messages: [{ role: 'user', content: 'Use UUID ids' }],
      });

      expect(chat.chatId).toBe('chat_chat-uuid');
      expect(chat.turnIds).toEqual(['turn_turn-uuid']);
      expect(chat.messages[0]).toMatchObject({
        id: 'message_message-uuid',
        turnId: 'turn_turn-uuid',
      });
      expect(randomUUID).toHaveBeenCalledTimes(3);
    } finally {
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  it.each([
    ['crypto is unavailable', undefined],
    ['crypto.randomUUID is unavailable', {}],
    ['crypto.randomUUID returns no id', { randomUUID: vi.fn(() => '') }],
  ])('falls back to locally generated ids when %s', async (_label, cryptoValue) => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    vi.stubGlobal('crypto', cryptoValue);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(123456);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      const { chat } = await appendChatTurn('article', null, {
        messages: [{ role: 'user', content: 'Use fallback ids' }],
      });

      expect(chat.chatId).toBe('chat_2n9c_i');
      expect(chat.turnIds).toEqual(['turn_2n9c_i']);
      expect(chat.messages[0]).toMatchObject({
        id: 'message_2n9c_i',
        turnId: 'turn_2n9c_i',
      });
      expect(await readChat('article', chat.chatId)).toEqual(chat);
    } finally {
      dateNow.mockRestore();
      random.mockRestore();
      vi.stubGlobal('crypto', originalCrypto);
    }
  });

  it('creates the chat inline when chatId is falsy and persists the whole turn', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const { chat } = await appendChatTurn('article', null, {
      messages: [
        { role: 'user', content: 'Where is the evidence?' },
        {
          role: 'assistant',
          content: '',
          hidden: true,
          toolCalls: [{ id: 'call-1', name: 'highlight_span', arguments: {} }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'call-1', hidden: true },
        { role: 'assistant', content: 'It is on lines 2–3.', reasoning: 'looked at lines' },
      ],
      events: [{ eventType: 'highlight_span', data: { startLine: 2, endLine: 3 } }],
    });

    expect(chat.chatId).toMatch(/^chat_/);
    expect(chat.messages).toHaveLength(4);
    expect(chat.events).toHaveLength(1);
    expect(chat.messages[0]).toMatchObject({ role: 'user', content: 'Where is the evidence?' });
    expect(chat.messages[0].id).toMatch(/^message_/);
    expect(chat.messages[1]).toMatchObject({ role: 'assistant', hidden: true });
    expect(chat.messages[1].toolCalls).toEqual([
      { id: 'call-1', name: 'highlight_span', arguments: {} },
    ]);
    expect(chat.messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1' });
    // Provider reasoning is intentionally not retained in durable history.
    expect(chat.messages[3]).not.toHaveProperty('reasoning');
    expect(chat.events[0]).toMatchObject({
      seq: 1,
      eventType: 'highlight_span',
      data: { startLine: 2, endLine: 3 },
    });

    const stored = await readChat('article', chat.chatId);
    expect(stored).toEqual(chat);
    expect(stored.nextEventSeq).toBe(2);
    expect(await listChats('article')).toEqual([
      expect.objectContaining({
        chatId: chat.chatId,
        title: 'Where is the evidence?',
        messageCount: 2,
        eventCount: 1,
      }),
    ]);
  });

  it('normalizes an unrecognized or missing role to user', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const { chat } = await appendChatTurn('article', null, {
      messages: [
        { role: 'system', content: 'Not a real chat role.' },
        { content: 'No role at all.' },
      ],
    });

    expect(chat.messages[0].role).toBe('user');
    expect(chat.messages[1].role).toBe('user');
  });

  it('assigns sequential event seqs continuing from the chat nextEventSeq', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 1, endLine: 1 } }],
    });

    const { chat: updated } = await appendChatTurn('article', chat.chatId, {
      events: [
        { data: { startLine: 2, endLine: 2 } },
        { data: { startLine: 3, endLine: 3 } },
        { data: { startLine: 4, endLine: 4 } },
      ],
    });

    expect(updated.events.slice(-3).map((event) => event.seq)).toEqual([2, 3, 4]);
    const stored = await readChat('article', chat.chatId);
    expect(stored.events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(stored.nextEventSeq).toBe(5);
  });

  it('derives the next event seq from stored events when metadata is stale', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 1, endLine: 1 } }],
    });
    const stored = mock.storage.local._store.get(`pagetollm:chats:article:${chat.chatId}`);
    stored.events[0].seq = 8;
    stored.nextEventSeq = 2;

    const { chat: updated } = await appendChatTurn('article', chat.chatId, {
      events: [{ data: { startLine: 2, endLine: 2 } }],
    });
    expect(updated.events.at(-1).seq).toBe(9);
  });

  it('is idempotent by turnId, including creation retries without a chatId', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const turn = {
      turnId: 'turn-client-1',
      messages: [{ role: 'user', content: 'Only once' }],
      events: [{ data: { startLine: 1, endLine: 1 } }],
    };

    const first = await appendChatTurn('article', null, turn);
    const retried = await appendChatTurn('article', null, turn);

    expect(retried.chat.chatId).toBe(first.chat.chatId);
    expect(retried.chat.messages).toEqual(first.chat.messages);
    expect(retried.chat.events).toEqual(first.chat.events);
    expect(retried.chat.messages).toHaveLength(1);
    expect(retried.chat.messages[0].turnId).toBe(turn.turnId);
  });

  it('deletes chats and their index entries after the record content revision changes', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      turnId: 'before-reprocess',
      messages: [{ role: 'user', content: 'Old content question' }],
    });

    await updateRecord('article', { text: 'replacement' }, { bumpContentRevision: true });

    expect(await listChats('article')).toEqual([]);
    expect(await readChat('article', chat.chatId)).toBeNull();
    expect(mock.storage.local._store.has(`pagetollm:chats:article:${chat.chatId}`)).toBe(false);
    expect(mock.storage.local._store.has('pagetollm:chats:article:index')).toBe(false);
    await expect(
      appendChatTurn('article', chat.chatId, {
        turnId: 'after-reprocess',
        messages: [{ role: 'user', content: 'New content question' }],
      }),
    ).rejects.toThrow('chat not found');
  });

  it('deletes stale chats when writeRecord replaces an existing content revision', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      turnId: 'before-import',
      messages: [{ role: 'user', content: 'Old imported content question' }],
    });

    await writeRecord(makeRecord('article', { text: 'imported replacement' }), {
      bumpContentRevision: true,
    });

    expect(mock.storage.local._store.has(`pagetollm:chats:article:${chat.chatId}`)).toBe(false);
    expect(mock.storage.local._store.has('pagetollm:chats:article:index')).toBe(false);
  });

  it('retains a bounded number of complete recent turns', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    let chatId = null;
    for (let i = 0; i < MAX_CHAT_TURNS + 3; i += 1) {
      const result = await appendChatTurn('article', chatId, {
        turnId: `turn-${i}`,
        messages: [
          { role: 'user', content: `Question ${i}` },
          { role: 'assistant', content: `Answer ${i}` },
        ],
      });
      chatId = result.chat.chatId;
    }

    const stored = await readChat('article', chatId);
    expect(stored.turnIds).toHaveLength(MAX_CHAT_TURNS);
    expect(stored.messages).toHaveLength(MAX_CHAT_TURNS * 2);
    expect(stored.messages[0].content).toBe('Question 3');
    const retryIndex = mock.storage.local._store.get('pagetollm:chats:article:index').turns;
    expect(retryIndex).toHaveLength(MAX_CHAT_TURNS);
    expect(retryIndex.map((item) => item.turnId)).toEqual(
      Array.from({ length: MAX_CHAT_TURNS }, (_, i) => `turn-${i + 3}`),
    );
  });

  it('derives the title from the first visible user message in the batch', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const longQuestion = `What ${'exactly '.repeat(20)}happened?`;
    const { chat } = await appendChatTurn('article', null, {
      messages: [
        { role: 'user', content: 'hidden preamble', hidden: true },
        { role: 'user', content: `  ${longQuestion}  ` },
        { role: 'assistant', content: 'An answer.' },
      ],
    });

    expect(chat.title).toBe(longQuestion.slice(0, 60));
    expect(chat.titleIsDefault).toBe(false);
  });

  it('leaves the placeholder title on turns with no visible user message', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'assistant', content: 'Unprompted note.' }],
    });

    expect(chat.title).toBe('New chat');
    expect(chat.titleIsDefault).toBe(true);
  });

  it('is a single storage write for the whole turn', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 0, endLine: 0 } }],
    });
    mock.storage.local.set.mockClear();

    await appendChatTurn('article', chat.chatId, {
      messages: [
        { role: 'user', content: 'Question' },
        { role: 'assistant', content: 'Answer' },
      ],
      events: [{ data: { startLine: 1, endLine: 1 } }],
    });

    expect(mock.storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('persists nothing when the single write fails mid-turn', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'seed', hidden: true }],
    });
    const seedMessages = chat.messages;
    mock._state.lastErrorOnSet = true;

    await expect(
      appendChatTurn('article', chat.chatId, {
        messages: [
          { role: 'user', content: 'Question' },
          { role: 'assistant', content: '', hidden: true, toolCalls: [{ id: 'call-1' }] },
        ],
      }),
    ).rejects.toThrow('QuotaExceededError');

    mock._state.lastErrorOnSet = false;
    // No dangling partial turn: the chat is exactly as it was before the turn.
    const stored = await readChat('article', chat.chatId);
    expect(stored.messages).toEqual(seedMessages);
    expect(stored.events).toEqual([]);
  });

  it('creates no orphan chat when the first turn fails to persist', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    mock._state.lastErrorOnSet = true;

    await expect(
      appendChatTurn('article', null, { messages: [{ role: 'user', content: 'Question' }] }),
    ).rejects.toThrow('QuotaExceededError');

    mock._state.lastErrorOnSet = false;
    expect(await listChats('article')).toEqual([]);
  });

  it('throws on an empty turn', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 0, endLine: 0 } }],
    });

    await expect(appendChatTurn('article', chat.chatId, {})).rejects.toThrow(
      'at least one message or event',
    );
    await expect(
      appendChatTurn('article', chat.chatId, { messages: [], events: [] }),
    ).rejects.toThrow('at least one message or event');
  });

  it('throws chat not found for an unknown chatId', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    await expect(
      appendChatTurn('article', 'chat_missing', {
        messages: [{ role: 'user', content: 'Question' }],
      }),
    ).rejects.toThrow('chat not found');
  });

  it('throws record not found when creating a chat for a missing record', async () => {
    vi.stubGlobal('chrome', makeChromeMock());

    await expect(
      appendChatTurn('missing', null, { messages: [{ role: 'user', content: 'Question' }] }),
    ).rejects.toThrow('record not found');
  });
});
