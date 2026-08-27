// @vitest-environment happy-dom
import React, { Activity, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { eventRange, useChatSessions } from './useChatSessions.js';

// In-memory chat repository fake: the hook takes the port as an option, so no
// module mocking (and no Chrome realm) is involved.
const api = {
  get: vi.fn(),
  list: vi.fn(),
  remove: vi.fn(),
};

const cleanups = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

function setup({ recordKey = 'record-1', applyEvents = vi.fn(), chatRepository = api } = {}) {
  let props = { recordKey, applyEvents, chatRepository };
  let value;
  const container = document.createElement('div');
  const root = createRoot(container);

  function Harness() {
    value = useChatSessions(props);
    return null;
  }

  act(() => root.render(<Harness />));
  const cleanup = () => act(() => root.unmount());
  cleanups.push(cleanup);

  return {
    applyEvents,
    get current() {
      return value;
    },
    rerender(nextProps) {
      props = { ...props, ...nextProps };
      act(() => root.render(<Harness />));
    },
    cleanup,
  };
}

function chat(chatId, { messages = [], events = [] } = {}) {
  return { chatId, messages, events };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  api.list.mockResolvedValue([]);
  api.get.mockResolvedValue(null);
  api.remove.mockResolvedValue(undefined);
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('eventRange', () => {
  it('maps highlight events, normalizes numeric lines, and defaults the label', () => {
    expect(
      eventRange({
        eventType: 'highlight_span',
        data: { startLine: '2', endLine: 4, label: 'Evidence' },
      }),
    ).toEqual({ startLine: 2, endLine: 4, label: 'Evidence' });
    expect(
      eventRange({ eventType: 'highlight_span', data: { startLine: 0, endLine: -1, label: 0 } }),
    ).toEqual({ startLine: 0, endLine: -1, label: '' });
  });

  it.each([
    null,
    {},
    { eventType: 'other', data: { startLine: 1, endLine: 2 } },
    { eventType: 'highlight_span', data: { startLine: 1.5, endLine: 2 } },
    { eventType: 'highlight_span', data: { startLine: 1, endLine: 'not-a-number' } },
  ])('rejects a non-paintable event %#', (event) => {
    expect(eventRange(event)).toBeNull();
  });
});

describe('useChatSessions', () => {
  it('loads the first stored chat and paints every event from its latest turn', async () => {
    const summaries = [{ chatId: 'chat-1' }, { chatId: 'chat-2' }];
    const events = [
      { seq: 1, turnId: 'turn-a' },
      { seq: 2, turnId: 'turn-b' },
      { seq: 3, turnId: 'turn-b' },
    ];
    api.list.mockResolvedValue(summaries);
    api.get.mockResolvedValue(
      chat('chat-1', { messages: [{ role: 'assistant', content: 'answer' }], events }),
    );
    const ctx = setup();

    expect(ctx.current.isLoadingHistory).toBe(true);
    await flushAsyncWork();

    expect(ctx.current.chats).toEqual(summaries);
    expect(ctx.current.activeChatId).toBe('chat-1');
    expect(ctx.current.messages).toEqual([{ role: 'assistant', content: 'answer' }]);
    expect(ctx.current.events).toEqual(events);
    expect(ctx.current.paintedEvents).toEqual(events.slice(1));
    expect(ctx.current.selectedEventSeq).toBe(3);
    expect(ctx.current.isLoadingHistory).toBe(false);
    expect(ctx.current.error).toBe('');
    expect(ctx.applyEvents).toHaveBeenLastCalledWith(events.slice(1));
  });

  it('adopts safe empty values from a missing chat and supports explicit selection clearing', async () => {
    api.list.mockResolvedValue([{ chatId: 'chat-1' }]);
    api.get.mockResolvedValue({ chatId: '', messages: null, events: 'invalid' });
    const ctx = setup();
    await flushAsyncWork();

    expect(ctx.current.activeChatId).toBeNull();
    expect(ctx.current.messages).toEqual([]);
    expect(ctx.current.events).toEqual([]);
    expect(ctx.current.paintedEvents).toEqual([]);
    expect(ctx.current.selectedEventSeq).toBeNull();
    expect(ctx.applyEvents).toHaveBeenLastCalledWith([]);

    act(() => ctx.current.setError('old error'));
    act(() => ctx.current.startNewChat());
    expect(ctx.current.error).toBe('');
    expect(ctx.current.isLoadingHistory).toBe(false);
  });

  it('selects one ungrouped event, selects a complete turn, and clears the paint', async () => {
    const events = [{ seq: 1, turnId: 'turn-a' }, { seq: 2 }, { seq: 3, turnId: 'turn-a' }];
    api.list.mockResolvedValue([{ chatId: 'chat-1' }]);
    api.get.mockResolvedValue(chat('chat-1', { events }));
    const ctx = setup();
    await flushAsyncWork();
    ctx.applyEvents.mockClear();

    act(() => ctx.current.selectEvent(events[1]));
    expect(ctx.current.selectedEventSeq).toBe(2);
    expect(ctx.current.paintedEvents).toEqual([events[1]]);
    expect(ctx.applyEvents).toHaveBeenLastCalledWith([events[1]], { focusEvent: events[1] });

    act(() => ctx.current.selectEvent(events[0]));
    expect(ctx.current.paintedEvents).toEqual([events[0], events[2]]);
    expect(ctx.applyEvents).toHaveBeenLastCalledWith([events[0], events[2]], {
      focusEvent: events[0],
    });

    act(() => ctx.current.clearSelection());
    expect(ctx.current.selectedEventSeq).toBeNull();
    expect(ctx.current.paintedEvents).toEqual([]);
    expect(ctx.applyEvents).toHaveBeenLastCalledWith([]);
  });

  it('loads chats explicitly, rejects missing identifiers, and reports load failures', async () => {
    const ctx = setup();
    await flushAsyncWork();
    expect(await ctx.current.loadChat('')).toBe(false);
    expect(api.get).not.toHaveBeenCalled();

    api.get.mockResolvedValueOnce(chat('chat-2', { messages: [{ content: 'two' }] }));
    let loaded;
    await act(async () => {
      loaded = await ctx.current.loadChat('chat-2');
    });
    expect(loaded).toBe(true);
    expect(ctx.current.activeChatId).toBe('chat-2');
    expect(ctx.current.messages).toEqual([{ content: 'two' }]);
    expect(ctx.current.isLoadingHistory).toBe(false);

    api.get.mockRejectedValueOnce(new Error('history unavailable'));
    await act(async () => {
      loaded = await ctx.current.loadChat('chat-broken');
    });
    expect(loaded).toBe(false);
    expect(ctx.current.error).toBe('history unavailable');
    expect(ctx.current.isLoadingHistory).toBe(false);

    api.get.mockRejectedValueOnce(null);
    await act(async () => {
      await ctx.current.loadChat('chat-broken-again');
    });
    expect(ctx.current.error).toBe('Failed to load chat history.');
  });

  it('keeps the newest explicit load when requests complete out of order', async () => {
    const first = deferred();
    const second = deferred();
    const ctx = setup();
    await flushAsyncWork();
    api.get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let firstResult;
    let secondResult;
    act(() => {
      void ctx.current.loadChat('chat-old').then((result) => {
        firstResult = result;
      });
      void ctx.current.loadChat('chat-new').then((result) => {
        secondResult = result;
      });
    });
    await act(async () => second.resolve(chat('chat-new', { messages: [{ content: 'new' }] })));
    await act(async () => first.resolve(chat('chat-old', { messages: [{ content: 'old' }] })));

    expect(secondResult).toBe(true);
    expect(firstResult).toBe(false);
    expect(ctx.current.activeChatId).toBe('chat-new');
    expect(ctx.current.messages).toEqual([{ content: 'new' }]);
    expect(ctx.current.isLoadingHistory).toBe(false);
  });

  it('refreshes summaries and ignores the result after the record changes', async () => {
    const ctx = setup();
    await flushAsyncWork();
    api.list.mockResolvedValueOnce([{ chatId: 'fresh' }]);
    let result;
    await act(async () => {
      result = await ctx.current.refreshChats();
    });
    expect(result).toEqual([{ chatId: 'fresh' }]);
    expect(ctx.current.chats).toEqual([{ chatId: 'fresh' }]);

    const pending = deferred();
    api.list.mockReturnValueOnce(pending.promise);
    let staleResult;
    act(() => {
      void ctx.current.refreshChats().then((value) => {
        staleResult = value;
      });
    });
    ctx.rerender({ recordKey: 'record-2' });
    api.list.mockResolvedValueOnce([]);
    await act(async () => pending.resolve([{ chatId: 'stale' }]));
    await flushAsyncWork();

    expect(staleResult).toEqual([{ chatId: 'stale' }]);
    expect(ctx.current.chats).toEqual([]);
  });

  it('does not request chats when refresh has no record key', async () => {
    const ctx = setup({ recordKey: '' });
    await flushAsyncWork();
    api.list.mockClear();

    expect(await ctx.current.refreshChats()).toEqual([]);
    expect(api.list).not.toHaveBeenCalled();
  });

  it('deletes an inactive chat and refreshes the summaries', async () => {
    api.list
      .mockResolvedValueOnce([{ chatId: 'active' }, { chatId: 'other' }])
      .mockResolvedValueOnce([{ chatId: 'active' }]);
    api.get.mockResolvedValue(chat('active'));
    const ctx = setup();
    await flushAsyncWork();

    let result;
    await act(async () => {
      result = await ctx.current.deleteChat('other');
    });
    expect(result).toBe(true);
    expect(api.remove).toHaveBeenCalledWith('record-1', 'other');
    expect(ctx.current.chats).toEqual([{ chatId: 'active' }]);
    expect(ctx.current.activeChatId).toBe('active');
    expect(ctx.current.isMutatingHistory).toBe(false);
    expect(ctx.current.error).toBe('');
  });

  it('deletes the active chat and loads the next available chat', async () => {
    api.list
      .mockResolvedValueOnce([{ chatId: 'active' }, { chatId: 'next' }])
      .mockResolvedValueOnce([{ chatId: 'next' }]);
    api.get
      .mockResolvedValueOnce(chat('active'))
      .mockResolvedValueOnce(chat('next', { messages: [{ content: 'next message' }] }));
    const ctx = setup();
    await flushAsyncWork();

    let result;
    await act(async () => {
      result = await ctx.current.deleteChat('active');
    });
    expect(result).toBe(true);
    expect(api.get).toHaveBeenLastCalledWith('record-1', 'next');
    expect(ctx.current.activeChatId).toBe('next');
    expect(ctx.current.messages).toEqual([{ content: 'next message' }]);
  });

  it('starts a new chat after deleting the final active chat', async () => {
    api.list.mockResolvedValueOnce([{ chatId: 'only' }]).mockResolvedValueOnce([]);
    api.get.mockResolvedValue(chat('only', { messages: [{ content: 'old' }] }));
    const ctx = setup();
    await flushAsyncWork();

    await act(async () => ctx.current.deleteChat('only'));
    expect(ctx.current.chats).toEqual([]);
    expect(ctx.current.activeChatId).toBeNull();
    expect(ctx.current.messages).toEqual([]);
    expect(ctx.current.isLoadingHistory).toBe(false);
  });

  it('rejects an empty delete and surfaces both explicit and fallback delete errors', async () => {
    const ctx = setup();
    await flushAsyncWork();
    expect(await ctx.current.deleteChat(null)).toBe(false);
    expect(api.remove).not.toHaveBeenCalled();

    api.remove.mockRejectedValueOnce(new Error('cannot delete'));
    await act(async () => {
      expect(await ctx.current.deleteChat('broken')).toBe(false);
    });
    expect(ctx.current.error).toBe('cannot delete');
    expect(ctx.current.isMutatingHistory).toBe(false);

    api.remove.mockRejectedValueOnce(undefined);
    await act(async () => {
      expect(await ctx.current.deleteChat('broken-again')).toBe(false);
    });
    expect(ctx.current.error).toBe('Failed to delete chat.');
  });

  it('resets isMutatingHistory if the panel is hidden mid-delete via Activity', async () => {
    const removal = deferred();
    api.list
      .mockResolvedValueOnce([{ chatId: 'active' }, { chatId: 'other' }])
      .mockResolvedValue([{ chatId: 'active' }]);
    api.get.mockResolvedValue(chat('active'));
    api.remove.mockReturnValueOnce(removal.promise);

    let value;
    const applyEvents = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    function Harness() {
      value = useChatSessions({ recordKey: 'record-1', applyEvents, chatRepository: api });
      return null;
    }
    act(() =>
      root.render(
        <Activity mode="visible">
          <Harness />
        </Activity>,
      ),
    );
    await flushAsyncWork();

    let deletePromise;
    act(() => {
      deletePromise = value.deleteChat('other');
    });
    await act(async () => Promise.resolve());
    expect(value.isMutatingHistory).toBe(true);

    // Toolbar toggle hides the panel (e.g. via <Activity mode="hidden">) while
    // the delete is still in flight — the hook stays mounted, only hidden.
    act(() =>
      root.render(
        <Activity mode="hidden">
          <Harness />
        </Activity>,
      ),
    );
    await flushAsyncWork();
    expect(value.isMutatingHistory).toBe(false);

    await act(async () => {
      removal.resolve(undefined);
      await deletePromise;
    });

    // Reopen: the flag must not be stuck disabled by the deferred completion.
    act(() =>
      root.render(
        <Activity mode="visible">
          <Harness />
        </Activity>,
      ),
    );
    await flushAsyncWork();
    expect(value.isMutatingHistory).toBe(false);

    act(() => root.unmount());
  });

  it('serializes deletes even when an earlier mutation rejects internally', async () => {
    const removal = deferred();
    api.remove.mockReturnValueOnce(removal.promise).mockResolvedValueOnce(undefined);
    api.list.mockResolvedValue([]);
    const ctx = setup();
    await flushAsyncWork();

    let first;
    let second;
    act(() => {
      first = ctx.current.deleteChat('first');
      second = ctx.current.deleteChat('second');
    });
    await act(async () => Promise.resolve());
    expect(api.remove).toHaveBeenCalledTimes(1);
    await act(async () => {
      removal.reject(new Error('first failed'));
      await first;
      await second;
    });

    expect(await first).toBe(false);
    expect(api.remove).toHaveBeenCalledTimes(2);
    expect(api.remove).toHaveBeenLastCalledWith('record-1', 'second');
  });

  it('adopts an authoritative persisted turn only for the active session', async () => {
    const oldEvents = [{ seq: 1, turnId: 'old' }];
    api.list.mockResolvedValue([{ chatId: 'chat-1' }]);
    api.get.mockResolvedValue(
      chat('chat-1', { messages: [{ content: 'old' }], events: oldEvents }),
    );
    const ctx = setup();
    await flushAsyncWork();

    expect(
      ctx.current.adoptPersistedTurn({ chat: { chatId: 'other' } }, { expectedChatId: null }),
    ).toBe(false);
    expect(ctx.current.adoptPersistedTurn({}, { expectedChatId: 'chat-1', turnId: 'new' })).toBe(
      false,
    );

    const newEvents = [oldEvents[0], { seq: 2, turnId: 'new' }, { seq: 3, turnId: 'new' }];
    let adopted;
    act(() => {
      adopted = ctx.current.adoptPersistedTurn(
        {
          chat: {
            chatId: 'chat-1',
            messages: [{ content: 'authoritative' }],
            events: newEvents,
          },
          messages: [{ content: 'ignored fallback' }],
          events: [{ seq: 2 }],
        },
        { expectedChatId: 'chat-1', turnId: 'new' },
      );
    });
    expect(adopted).toBe(true);
    expect(ctx.current.messages).toEqual([{ content: 'authoritative' }]);
    expect(ctx.current.events).toEqual(newEvents);
    expect(ctx.current.paintedEvents).toEqual(newEvents.slice(1));
    expect(ctx.current.selectedEventSeq).toBe(3);
  });

  it('reconciles a committed turn and rejects incomplete, stale, and failed reconciliations', async () => {
    api.list.mockResolvedValue([{ chatId: 'chat-1' }]);
    api.get.mockResolvedValueOnce(chat('chat-1'));
    const ctx = setup();
    await flushAsyncWork();

    expect(await ctx.current.reconcilePersistedTurn('', 'turn-1')).toBe(false);
    expect(await ctx.current.reconcilePersistedTurn('chat-1', '')).toBe(false);

    api.get.mockResolvedValueOnce(
      chat('chat-1', {
        messages: [{ turnId: 'other' }],
        events: [{ seq: 1, turnId: 'other' }],
      }),
    );
    expect(await ctx.current.reconcilePersistedTurn('chat-1', 'turn-1')).toBe(false);

    const committed = chat('chat-1', {
      messages: [{ turnId: 'turn-1', content: 'committed' }],
      events: [
        { seq: 1, turnId: 'other' },
        { seq: 2, turnId: 'turn-1' },
      ],
    });
    api.get.mockResolvedValueOnce(committed);
    let reconciled;
    await act(async () => {
      reconciled = await ctx.current.reconcilePersistedTurn('chat-1', 'turn-1');
    });
    expect(reconciled).toBe(true);
    expect(ctx.current.messages).toEqual(committed.messages);
    expect(ctx.current.paintedEvents).toEqual([committed.events[1]]);
    expect(ctx.current.selectedEventSeq).toBe(2);

    act(() => ctx.current.startNewChat());
    api.get.mockResolvedValueOnce(committed);
    expect(await ctx.current.reconcilePersistedTurn('chat-1', 'turn-1')).toBe(false);

    api.get.mockRejectedValueOnce(new Error('network'));
    expect(await ctx.current.reconcilePersistedTurn('chat-1', 'turn-1')).toBe(false);
  });
});
