// @vitest-environment happy-dom
import React, { Activity, act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ArticleChatPanel from './ArticleChat.jsx';

// In-memory chat repository and turn runner fakes, injected through the panel's
// ports instead of mocking the ./chatApi.js and ./articleChat.js modules.
const api = {
  list: vi.fn(),
  get: vi.fn(),
  append: vi.fn(),
  remove: vi.fn(),
};
const turnLoop = { runArticleChatTurn: vi.fn() };
const chatLimits = {
  getChatLimits: vi.fn(async () => ({ maxChunkChars: 1258, maxHistoryChars: 628 })),
};

/** ArticleChat with the fake ports pre-wired; props still override freely. */
function ArticleChat(props) {
  return (
    <ArticleChatPanel
      chatRepository={api}
      runTurn={turnLoop.runArticleChatTurn}
      getChatLimits={chatLimits.getChatLimits}
      {...props}
    />
  );
}

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    rerender(nextElement) {
      act(() => root.render(nextElement));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function flushAsyncWork() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

function typeQuestion(container, text) {
  const textarea = container.querySelector('.pagetollm-chat-composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  act(() => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function clickSend(container) {
  const sendButton = container.querySelector('.pagetollm-chat-composer button');
  await act(async () => sendButton.click());
  await flushAsyncWork();
}

describe('ArticleChat persisted history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    chatLimits.getChatLimits.mockResolvedValue({ maxChunkChars: 1258, maxHistoryChars: 628 });
    api.list.mockResolvedValue([
      {
        chatId: 'chat-1',
        title: 'First chat',
        updatedAt: 200,
        messageCount: 2,
        eventCount: 1,
      },
      {
        chatId: 'chat-2',
        title: 'Second chat',
        updatedAt: 100,
        messageCount: 2,
        eventCount: 1,
      },
    ]);
    api.get.mockImplementation(async (_key, chatId) => ({
      chatId,
      messages: [
        { id: `${chatId}-u`, role: 'user', content: `Question ${chatId}` },
        { id: `${chatId}-a`, role: 'assistant', content: `Answer ${chatId}` },
      ],
      events: [
        {
          seq: chatId === 'chat-1' ? 1 : 2,
          eventType: 'highlight_span',
          data:
            chatId === 'chat-1'
              ? { startLine: 1, endLine: 2, label: 'First evidence' }
              : { startLine: 3, endLine: 3, label: 'Second evidence' },
        },
      ],
    }));
  });

  it('uses a compact Canvas header with actions on the left and close on the right', () => {
    const onClose = vi.fn();
    const { container, unmount } = render(
      <ArticleChat recordKey="record-1" sentences={['One']} onClose={onClose} />,
    );

    const header = container.querySelector('.pagetollm-chat-header');
    expect(container.querySelector('.pagetollm-chat-title')).toBeNull();
    expect(container.querySelector('.pagetollm-chat-subtitle')).toBeNull();
    expect(header.firstElementChild.className).toBe('pagetollm-chat-actions');
    expect(header.lastElementChild.className).toBe('pagetollm-chat-close');
    act(() => header.lastElementChild.click());
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('loads the latest chat and switches messages and events by chat id', async () => {
    const onHighlight = vi.fn();
    const onClearHighlights = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
      />,
    );
    await flushAsyncWork();

    expect(api.list).toHaveBeenCalledWith('record-1');
    expect(api.get).toHaveBeenCalledWith('record-1', 'chat-1');
    expect(container.textContent).toContain('Question chat-1');
    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 1,
      endLine: 2,
      label: 'First evidence',
    });

    act(() => container.querySelector('.pagetollm-chat-actions button').click());
    const secondChatButton = Array.from(
      container.querySelectorAll('.pagetollm-chat-history-item > button:first-child'),
    ).find((button) => button.textContent.includes('Second chat'));
    await act(async () => secondChatButton.click());
    await flushAsyncWork();

    expect(api.get).toHaveBeenLastCalledWith('record-1', 'chat-2');
    expect(container.textContent).toContain('Question chat-2');
    expect(container.textContent).not.toContain('Question chat-1');
    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 3,
      endLine: 3,
      label: 'Second evidence',
    });

    const eventsTab = Array.from(container.querySelectorAll('.pagetollm-chat-tabs button')).find(
      (button) => button.textContent.includes('Events'),
    );
    act(() => eventsTab.click());
    expect(container.textContent).toContain('Lines 3–3');
    expect(container.textContent).toContain('Second evidence');

    unmount();
  });

  it('clears the selected event highlight on Escape', async () => {
    const onHighlight = vi.fn();
    const onClearHighlights = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
      />,
    );
    await flushAsyncWork();

    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 1,
      endLine: 2,
      label: 'First evidence',
    });
    onClearHighlights.mockClear();
    onHighlight.mockClear();

    // Escape outside the panel is not intercepted (important on host pages
    // such as YouTube, which have their own Escape behavior).
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClearHighlights).not.toHaveBeenCalled();

    act(() => {
      container
        .querySelector('.pagetollm-chat')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClearHighlights).toHaveBeenCalledTimes(1);
    expect(onHighlight).not.toHaveBeenCalled();

    onClearHighlights.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClearHighlights).not.toHaveBeenCalled();

    unmount();
  });

  it('exposes accessible tabs, an accessible composer name, and video-specific event states', async () => {
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={vi.fn()}
        onClearHighlights={vi.fn()}
        subject="video"
        getEventTimestamp={() => null}
      />,
    );
    await flushAsyncWork();

    const tabList = container.querySelector('[role="tablist"]');
    const tabs = tabList.querySelectorAll('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    const activePanel = container.querySelector(`#${tabs[0].getAttribute('aria-controls')}`);
    expect(activePanel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    expect(activePanel.style.display).not.toBe('none');

    const textarea = container.querySelector('.pagetollm-chat-composer textarea');
    const label = container.querySelector('.pagetollm-chat-composer label');
    expect(label).toBeNull();
    expect(textarea.getAttribute('aria-label')).toBe('Message');

    act(() => {
      tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);

    const eventButton = container.querySelector('.pagetollm-chat-event > button');
    expect(eventButton.disabled).toBe(true);
    expect(eventButton.textContent).toContain('Timestamp unavailable');
    expect(container.querySelectorAll('.pagetollm-chat-event > button')).toHaveLength(1);
    expect(container.querySelector('[aria-label^="Delete event"]')).toBeNull();
    unmount();
  });

  it('closes video chat with panel-scoped Escape but preserves a non-empty draft', async () => {
    const onEscape = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={vi.fn()}
        onClearHighlights={vi.fn()}
        onEscape={onEscape}
        subject="video"
        getEventTimestamp={() => 30}
      />,
    );
    await flushAsyncWork();

    const textarea = container.querySelector('.pagetollm-chat-composer textarea');
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).toHaveBeenCalledTimes(1);

    onEscape.mockClear();
    typeQuestion(container, 'Keep this draft');
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onEscape).not.toHaveBeenCalled();
    expect(container.querySelector('.pagetollm-chat-status.is-warning').textContent).toContain(
      'Send or clear your draft',
    );
    expect(textarea.value).toBe('Keep this draft');

    unmount();
  });

  it('moves focus into the composer when the chat panel becomes ready', async () => {
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One']}
        onHighlight={vi.fn()}
        onClearHighlights={vi.fn()}
      />,
    );
    await flushAsyncWork();

    expect(document.activeElement).toBe(
      container.querySelector('.pagetollm-chat-composer textarea'),
    );
    unmount();
  });

  it('clears highlights when the panel unmounts (chat closed)', async () => {
    const onHighlight = vi.fn();
    const onClearHighlights = vi.fn();
    const { unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
      />,
    );
    await flushAsyncWork();
    onClearHighlights.mockClear();

    unmount();

    expect(onClearHighlights).toHaveBeenCalledTimes(1);
  });

  it('persists the whole turn atomically and adopts the returned data', async () => {
    turnLoop.runArticleChatTurn.mockImplementation(
      async ({ effects: { onHighlight: paintHighlight } }) => {
        await paintHighlight({ startLine: 3, endLine: 3, label: 'New evidence' });
        return {
          reply: 'Line three answers it.',
          transcriptMessages: [
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call-1', name: 'highlight_span', arguments: {} }],
            },
            { role: 'tool', content: 'Highlighted lines 3-3.', toolCallId: 'call-1' },
          ],
          highlightRanges: [{ startLine: 3, endLine: 3, label: 'New evidence' }],
        };
      },
    );
    api.append.mockImplementation(async (_key, _chatId, turn) => ({
      chat: {
        chatId: 'chat-1',
        messages: [
          { id: 'm-3', role: 'user', content: 'What about line three?', turnId: turn.turnId },
          {
            id: 'm-6',
            role: 'assistant',
            content: 'Line three answers it.',
            turnId: turn.turnId,
          },
        ],
        events: [
          {
            seq: 1,
            eventType: 'highlight_span',
            data: { startLine: 1, endLine: 2, label: 'First evidence' },
          },
          {
            seq: 2,
            eventType: 'highlight_span',
            data: { startLine: 3, endLine: 3, label: 'New evidence' },
            turnId: turn.turnId,
          },
        ],
      },
    }));
    const onHighlight = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={vi.fn()}
      />,
    );
    await flushAsyncWork();

    typeQuestion(container, 'What about line three?');
    await clickSend(container);

    // Ranges handed to the turn loop are derived from the events state.
    expect(turnLoop.runArticleChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'What about line three?',
        limits: { maxChunkChars: 1258, maxHistoryChars: 628 },
        article: expect.objectContaining({
          highlightedRanges: [{ startLine: 1, endLine: 2, label: 'First evidence' }],
        }),
      }),
    );
    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 3,
      endLine: 3,
      label: 'New evidence',
    });
    // One atomic write: only replayable visible messages + events. Provider
    // tool transcripts stay transient and are not retained in chat storage.
    expect(api.append).toHaveBeenCalledTimes(1);
    expect(api.append).toHaveBeenCalledWith('record-1', 'chat-1', {
      turnId: expect.any(String),
      messages: [
        { role: 'user', content: 'What about line three?' },
        { role: 'assistant', content: 'Line three answers it.' },
      ],
      events: [
        {
          eventType: 'highlight_span',
          data: { startLine: 3, endLine: 3, label: 'New evidence' },
        },
      ],
    });

    // State adopts the returned normalized data.
    expect(container.textContent).toContain('What about line three?');
    expect(container.textContent).toContain('Line three answers it.');
    const eventsTab = Array.from(container.querySelectorAll('.pagetollm-chat-tabs button')).find(
      (button) => button.textContent.includes('Events'),
    );
    act(() => eventsTab.click());
    expect(container.textContent).toContain('Lines 3–3');
    expect(container.querySelector('.pagetollm-chat-event.is-active').textContent).toContain(
      'New evidence',
    );

    unmount();
  });

  it('paints streamed evidence without automatically focusing it', async () => {
    turnLoop.runArticleChatTurn.mockImplementation(
      async ({ effects: { onHighlight: paintHighlight } }) => {
        await paintHighlight({ startLine: 3, endLine: 3, label: 'Focused evidence' });
        return {
          reply: 'Focused answer.',
          transcriptMessages: [],
          highlightRanges: [{ startLine: 3, endLine: 3, label: 'Focused evidence' }],
        };
      },
    );
    api.append.mockImplementation(async (_key, _chatId, turn) => ({
      chat: {
        chatId: 'chat-1',
        messages: [
          { id: 'm-3', role: 'user', content: 'Focus this', turnId: turn.turnId },
          { id: 'm-4', role: 'assistant', content: 'Focused answer.', turnId: turn.turnId },
        ],
        events: [
          {
            seq: 2,
            eventType: 'highlight_span',
            data: { startLine: 3, endLine: 3, label: 'Focused evidence' },
            turnId: turn.turnId,
          },
        ],
      },
    }));
    const onHighlight = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={vi.fn()}
      />,
    );
    await flushAsyncWork();

    typeQuestion(container, 'Focus this');
    await clickSend(container);

    expect(onHighlight).toHaveBeenCalledWith({
      startLine: 3,
      endLine: 3,
      label: 'Focused evidence',
    });

    unmount();
  });

  it('rolls back the UI when the atomic persist fails', async () => {
    turnLoop.runArticleChatTurn.mockResolvedValue({
      reply: 'Lost answer.',
      transcriptMessages: [],
      highlightRanges: [{ startLine: 3, endLine: 3, label: 'Lost evidence' }],
    });
    api.append.mockRejectedValue(new Error('persist failed'));
    const onHighlight = vi.fn();
    const onClearHighlights = vi.fn();
    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
      />,
    );
    await flushAsyncWork();

    typeQuestion(container, 'Doomed question');
    await clickSend(container);

    expect(api.append).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.pagetollm-chat-error').textContent).toBe('persist failed');
    // The question returns to the composer and the optimistic bubble is gone.
    expect(container.querySelector('.pagetollm-chat-composer textarea').value).toBe(
      'Doomed question',
    );
    expect(container.textContent).not.toContain('Lost answer.');
    // Stream-painted highlights are reset to the stored selected event.
    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 1,
      endLine: 2,
      label: 'First evidence',
    });

    unmount();
  });

  it('keeps the persisted turn when the post-turn chat-list refresh fails', async () => {
    turnLoop.runArticleChatTurn.mockResolvedValue({
      reply: 'Line three answers it.',
      transcriptMessages: [],
      highlightRanges: [{ startLine: 3, endLine: 3, label: 'New evidence' }],
    });
    api.append.mockImplementation(async (_key, _chatId, turn) => ({
      chat: {
        chatId: 'chat-1',
        messages: [
          { id: 'm-3', role: 'user', content: 'What about line three?', turnId: turn.turnId },
          {
            id: 'm-4',
            role: 'assistant',
            content: 'Line three answers it.',
            turnId: turn.turnId,
          },
        ],
        events: [
          {
            seq: 2,
            eventType: 'highlight_span',
            data: { startLine: 3, endLine: 3, label: 'New evidence' },
            turnId: turn.turnId,
          },
        ],
      },
    }));
    // Mount lists chats once (resolves); the post-turn refresh is the second
    // call and rejects — the round-trip fails after the turn was persisted.
    api.list
      .mockResolvedValueOnce([
        { chatId: 'chat-1', title: 'First chat', updatedAt: 200, messageCount: 2, eventCount: 1 },
      ])
      .mockRejectedValueOnce(new Error('list failed'));

    const { container, unmount } = render(
      <ArticleChat
        recordKey="record-1"
        sentences={['One', 'Two', 'Three']}
        onHighlight={vi.fn()}
        onClearHighlights={vi.fn()}
      />,
    );
    await flushAsyncWork();

    typeQuestion(container, 'What about line three?');
    await clickSend(container);

    expect(api.append).toHaveBeenCalledTimes(1);
    // No rollback and no error banner: the refresh failure is swallowed.
    expect(container.querySelector('.pagetollm-chat-error')).toBeNull();
    expect(container.querySelector('.pagetollm-chat-composer textarea').value).toBe('');
    // The adopted assistant reply stays visible.
    expect(container.textContent).toContain('Line three answers it.');

    unmount();
  });

  it('ignores a stale chat load that resolves after a newer selection', async () => {
    let resolveSecond;
    let resolveFirst;
    api.get.mockImplementation((_key, chatId) => {
      if (api.get.mock.calls.length === 1) {
        return Promise.resolve({
          chatId: 'chat-1',
          messages: [],
          events: [],
        });
      }
      return new Promise((resolve) => {
        if (chatId === 'chat-1') resolveFirst = resolve;
        else resolveSecond = resolve;
      });
    });
    const { container, unmount } = render(
      <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />,
    );
    await flushAsyncWork();

    act(() => container.querySelector('.pagetollm-chat-actions button').click());
    const buttons = container.querySelectorAll('.pagetollm-chat-history-item > button:first-child');
    act(() => buttons[0].click());
    act(() => buttons[1].click());
    await act(async () => {
      resolveSecond({
        chatId: 'chat-2',
        messages: [{ role: 'assistant', content: 'Newest selection' }],
        events: [],
      });
    });
    await act(async () => {
      resolveFirst({
        chatId: 'chat-1',
        messages: [{ role: 'assistant', content: 'Stale selection' }],
        events: [],
      });
    });
    await flushAsyncWork();

    expect(container.textContent).toContain('Newest selection');
    expect(container.textContent).not.toContain('Stale selection');
    unmount();
  });

  it('does not persist a turn that finishes after the panel unmounts', async () => {
    let finishTurn;
    turnLoop.runArticleChatTurn.mockReturnValue(
      new Promise((resolve) => {
        finishTurn = resolve;
      }),
    );
    const { container, unmount } = render(
      <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />,
    );
    await flushAsyncWork();
    typeQuestion(container, 'Will be closed');
    await act(async () => container.querySelector('.pagetollm-chat-composer button').click());
    const turnOptions = turnLoop.runArticleChatTurn.mock.calls[0][0];
    expect(turnOptions.runtime.turnId).toEqual(expect.any(String));
    expect(turnOptions.runtime.signal.aborted).toBe(false);
    unmount();
    expect(turnOptions.runtime.signal.aborted).toBe(true);
    await act(async () => {
      finishTurn({ reply: 'Too late', transcriptMessages: [], highlightRanges: [] });
    });
    await flushAsyncWork();

    expect(api.append).not.toHaveBeenCalled();
  });

  it('offers a Stop action that aborts the turn and restores the question', async () => {
    turnLoop.runArticleChatTurn.mockImplementation(
      ({ runtime: { signal } }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('The chat turn was cancelled.');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const { container, unmount } = render(
      <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />,
    );
    await flushAsyncWork();
    typeQuestion(container, 'Please stop this');
    await clickSend(container);
    const turnOptions = turnLoop.runArticleChatTurn.mock.calls[0][0];
    const stopButton = Array.from(
      container.querySelectorAll('.pagetollm-chat-composer button'),
    ).find((button) => button.textContent === 'Stop');

    expect(stopButton).toBeDefined();
    act(() => stopButton.click());
    await flushAsyncWork();

    expect(turnOptions.runtime.signal.aborted).toBe(true);
    expect(api.append).not.toHaveBeenCalled();
    expect(container.querySelector('.pagetollm-chat-composer textarea').value).toBe(
      'Please stop this',
    );
    expect(container.querySelector('.pagetollm-chat-status.is-warning').textContent).toBe(
      'Response stopped.',
    );
    expect(container.querySelector('.pagetollm-chat-error')).toBeNull();

    await clickSend(container);
    expect(turnLoop.runArticleChatTurn).toHaveBeenCalledTimes(2);
    expect(turnLoop.runArticleChatTurn.mock.calls[1][0].runtime.turnId).not.toBe(
      turnOptions.runtime.turnId,
    );
    unmount();
  });

  it('resets loading after recordKey changes during a turn', async () => {
    turnLoop.runArticleChatTurn.mockReturnValue(new Promise(() => {}));
    const view = render(
      <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />,
    );
    await flushAsyncWork();
    typeQuestion(view.container, 'Question for record one');
    await clickSend(view.container);
    const turnOptions = turnLoop.runArticleChatTurn.mock.calls[0][0];

    view.rerender(
      <ArticleChat recordKey="record-2" sentences={['Two']} onClearHighlights={vi.fn()} />,
    );
    await flushAsyncWork();

    expect(turnOptions.runtime.signal.aborted).toBe(true);
    expect(view.container.querySelector('.pagetollm-chat-composer textarea').disabled).toBe(false);
    expect(view.container.querySelector('.pagetollm-chat-composer button').textContent).toBe(
      'Send',
    );
    view.unmount();
  });

  it('resets loading if the panel is hidden mid-turn via Activity, so reopening it is usable', async () => {
    turnLoop.runArticleChatTurn.mockReturnValue(new Promise(() => {}));
    const view = render(
      <Activity mode="visible">
        <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />
      </Activity>,
    );
    await flushAsyncWork();
    typeQuestion(view.container, 'Question while chat is open');
    await clickSend(view.container);
    const turnOptions = turnLoop.runArticleChatTurn.mock.calls[0][0];
    expect(turnOptions.runtime.signal.aborted).toBe(false);

    // Toolbar toggle hides the panel (e.g. via <Activity mode="hidden">) while
    // the turn is still in flight — the panel stays mounted, only hidden.
    view.rerender(
      <Activity mode="hidden">
        <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />
      </Activity>,
    );
    await flushAsyncWork();
    expect(turnOptions.runtime.signal.aborted).toBe(true);

    // Reopen the panel: it must not be stuck disabled in the "Thinking…" state.
    view.rerender(
      <Activity mode="visible">
        <ArticleChat recordKey="record-1" sentences={['One']} onClearHighlights={vi.fn()} />
      </Activity>,
    );
    await flushAsyncWork();
    expect(view.container.querySelector('.pagetollm-chat-composer textarea').disabled).toBe(false);
    expect(view.container.querySelector('.pagetollm-chat-composer button').textContent).toBe(
      'Send',
    );
    expect(view.container.querySelector('.pagetollm-chat-status.is-error')).toBeNull();
    expect(api.append).not.toHaveBeenCalled();

    view.unmount();
  });
});
