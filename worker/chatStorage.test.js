import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  listChats,
  readChat,
  appendChatTurn,
  deleteChatEvent,
  deleteChatHistory,
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
    get: vi.fn((keys, cb) => {
      if (state.lastErrorOnGet) {
        runtime.lastError = { message: 'get failed' };
        cb({});
        runtime.lastError = null;
        return;
      }
      runtime.lastError = null;
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
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

  it('isolates events by chat and supports event/chat deletion', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat: first, events: firstEvents } = await appendChatTurn('article', null, {
      events: [{ eventType: 'highlight_span', data: { startLine: 1, endLine: 1 } }],
    });
    const { chat: second } = await appendChatTurn('article', null, {
      events: [{ eventType: 'highlight_span', data: { startLine: 4, endLine: 4 } }],
    });

    expect((await readChat('article', first.chatId)).events).toHaveLength(1);
    expect((await readChat('article', second.chatId)).events).toHaveLength(1);
    expect(await deleteChatEvent('article', first.chatId, firstEvents[0].seq)).toMatchObject({
      chatId: first.chatId,
      events: [],
    });
    expect((await readChat('article', first.chatId)).events).toEqual([]);
    expect((await readChat('article', second.chatId)).events).toHaveLength(1);
    expect(await deleteChatHistory('article', second.chatId)).toBe(true);
    expect(await readChat('article', second.chatId)).toBeNull();
  });

  it('removes all chat documents when the record is deleted', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Question' }],
    });

    await deleteRecord('article');

    expect(await listChats('article')).toEqual([]);
    expect(await readChat('article', chat.chatId)).toBeNull();
  });

  it('removes all chat documents when all records are deleted', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'Question' }],
    });

    await deleteAll();

    expect(await listChats('article')).toEqual([]);
    expect(await readChat('article', chat.chatId)).toBeNull();
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

  it('derives the title for already-stored chats missing the flag (backward compat)', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    // Simulate a chat written before titleIsDefault existed.
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 0, endLine: 0 } }],
    });
    const storedChat = mock.storage.local._store.get(`pagetollm:chats:article:${chat.chatId}`);
    delete storedChat.titleIsDefault;

    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: 'Legacy question' }],
    });
    const stored = await readChat('article', chat.chatId);
    expect(stored.title).toBe('Legacy question');
    expect(stored.titleIsDefault).toBe(false);
  });

  it('does not clobber a user-visible title on flagless chats that were already renamed', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    // A flagless legacy chat whose title was already derived is not re-derived.
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 0, endLine: 0 } }],
    });
    const storedChat = mock.storage.local._store.get(`pagetollm:chats:article:${chat.chatId}`);
    delete storedChat.titleIsDefault;
    storedChat.title = 'Already derived';

    await appendChatTurn('article', chat.chatId, {
      messages: [{ role: 'user', content: 'New question' }],
    });
    expect((await readChat('article', chat.chatId)).title).toBe('Already derived');
  });
});

// ---------------------------------------------------------------------------
// appendChatTurn — atomic whole-turn persistence
// ---------------------------------------------------------------------------

describe('appendChatTurn', () => {
  it('creates the chat inline when chatId is falsy and persists the whole turn', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));

    const { chat, messages, events } = await appendChatTurn('article', null, {
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
    expect(messages).toHaveLength(4);
    expect(events).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Where is the evidence?' });
    expect(messages[0].id).toMatch(/^message_/);
    expect(messages[1]).toMatchObject({ role: 'assistant', hidden: true });
    expect(messages[1].toolCalls).toEqual([
      { id: 'call-1', name: 'highlight_span', arguments: {} },
    ]);
    expect(messages[2]).toMatchObject({ role: 'tool', toolCallId: 'call-1' });
    // Provider reasoning is intentionally not retained in durable history.
    expect(messages[3]).not.toHaveProperty('reasoning');
    expect(events[0]).toMatchObject({
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

    const { messages } = await appendChatTurn('article', null, {
      messages: [
        { role: 'system', content: 'Not a real chat role.' },
        { content: 'No role at all.' },
      ],
    });

    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('user');
  });

  it('assigns sequential event seqs continuing from the chat nextEventSeq', async () => {
    const mock = makeChromeMock();
    vi.stubGlobal('chrome', mock);
    await seedRecord(mock, makeRecord('article'));
    const { chat } = await appendChatTurn('article', null, {
      events: [{ data: { startLine: 1, endLine: 1 } }],
    });

    const { events } = await appendChatTurn('article', chat.chatId, {
      events: [
        { data: { startLine: 2, endLine: 2 } },
        { data: { startLine: 3, endLine: 3 } },
        { data: { startLine: 4, endLine: 4 } },
      ],
    });

    expect(events.map((event) => event.seq)).toEqual([2, 3, 4]);
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

    const { events } = await appendChatTurn('article', chat.chatId, {
      events: [{ data: { startLine: 2, endLine: 2 } }],
    });
    expect(events[0].seq).toBe(9);
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

    expect(retried.duplicate).toBe(true);
    expect(retried.chat.chatId).toBe(first.chat.chatId);
    expect(retried.messages).toEqual(first.messages);
    expect(retried.events).toEqual(first.events);
    expect(retried.chat.messages).toHaveLength(1);
    expect(retried.messages[0].turnId).toBe(turn.turnId);
  });

  it('hides chats after the record content revision changes', async () => {
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
    await expect(
      appendChatTurn('article', chat.chatId, {
        turnId: 'after-reprocess',
        messages: [{ role: 'user', content: 'New content question' }],
      }),
    ).rejects.toThrow('chat not found');
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
    const { chat, messages: seedMessages } = await appendChatTurn('article', null, {
      messages: [{ role: 'user', content: 'seed', hidden: true }],
    });
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
