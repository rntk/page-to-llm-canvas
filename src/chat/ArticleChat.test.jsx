// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listStoredChats: vi.fn(),
  getStoredChat: vi.fn(),
  persistChatTurn: vi.fn(),
  removeStoredChat: vi.fn(),
  removeStoredChatEvent: vi.fn(),
}));
const turnLoop = vi.hoisted(() => ({ runArticleChatTurn: vi.fn() }));

vi.mock('./chatApi.js', () => api);
vi.mock('./articleChat.js', () => turnLoop);

import ArticleChat from './ArticleChat.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
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
    api.listStoredChats.mockResolvedValue([
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
    api.getStoredChat.mockImplementation(async (_key, chatId) => ({
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

    expect(api.listStoredChats).toHaveBeenCalledWith('record-1');
    expect(api.getStoredChat).toHaveBeenCalledWith('record-1', 'chat-1');
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

    expect(api.getStoredChat).toHaveBeenLastCalledWith('record-1', 'chat-2');
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

  it('persists the whole turn atomically and adopts the returned data', async () => {
    turnLoop.runArticleChatTurn.mockImplementation(async ({ onHighlight: paintHighlight }) => {
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
    });
    api.persistChatTurn.mockResolvedValue({
      chat: {
        chatId: 'chat-1',
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
          },
        ],
      },
      messages: [
        { id: 'm-3', role: 'user', content: 'What about line three?' },
        {
          id: 'm-4',
          role: 'assistant',
          content: '',
          hidden: true,
          toolCalls: [{ id: 'call-1', name: 'highlight_span', arguments: {} }],
        },
        { id: 'm-5', role: 'tool', content: 'Highlighted lines 3-3.', hidden: true },
        { id: 'm-6', role: 'assistant', content: 'Line three answers it.' },
      ],
      events: [
        {
          seq: 2,
          eventType: 'highlight_span',
          data: { startLine: 3, endLine: 3, label: 'New evidence' },
        },
      ],
    });
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
        highlightedRanges: [{ startLine: 1, endLine: 2, label: 'First evidence' }],
      }),
    );
    expect(onHighlight).toHaveBeenLastCalledWith({
      startLine: 3,
      endLine: 3,
      label: 'New evidence',
    });
    // One atomic write: user + hidden transcript + reply + events.
    expect(api.persistChatTurn).toHaveBeenCalledTimes(1);
    expect(api.persistChatTurn).toHaveBeenCalledWith('record-1', 'chat-1', {
      messages: [
        { role: 'user', content: 'What about line three?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'highlight_span', arguments: {} }],
          hidden: true,
        },
        { role: 'tool', content: 'Highlighted lines 3-3.', toolCallId: 'call-1', hidden: true },
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

  it('offers automatic event focus on the Events tab and leaves it disabled by default', async () => {
    turnLoop.runArticleChatTurn.mockImplementation(async ({ onHighlight: paintHighlight }) => {
      await paintHighlight({ startLine: 3, endLine: 3, label: 'Focused evidence' });
      return {
        reply: 'Focused answer.',
        transcriptMessages: [],
        highlightRanges: [{ startLine: 3, endLine: 3, label: 'Focused evidence' }],
      };
    });
    api.persistChatTurn.mockResolvedValue({
      chat: {
        chatId: 'chat-1',
        events: [
          {
            seq: 2,
            eventType: 'highlight_span',
            data: { startLine: 3, endLine: 3, label: 'Focused evidence' },
          },
        ],
      },
      messages: [
        { id: 'm-3', role: 'user', content: 'Focus this' },
        { id: 'm-4', role: 'assistant', content: 'Focused answer.' },
      ],
      events: [
        {
          seq: 2,
          eventType: 'highlight_span',
          data: { startLine: 3, endLine: 3, label: 'Focused evidence' },
        },
      ],
    });
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

    const eventsTab = Array.from(container.querySelectorAll('.pagetollm-chat-tabs button')).find(
      (button) => button.textContent.includes('Events'),
    );
    act(() => eventsTab.click());
    const autoFocus = container.querySelector('.pagetollm-chat-events-tab input');
    expect(autoFocus.checked).toBe(false);
    act(() => autoFocus.click());

    const chatTab = Array.from(container.querySelectorAll('.pagetollm-chat-tabs button')).find(
      (button) => button.textContent.includes('Chat'),
    );
    act(() => chatTab.click());
    typeQuestion(container, 'Focus this');
    await clickSend(container);

    expect(onHighlight).toHaveBeenLastCalledWith(
      { startLine: 3, endLine: 3, label: 'Focused evidence' },
      { focus: true },
    );

    unmount();
  });

  it('rolls back the UI when the atomic persist fails', async () => {
    turnLoop.runArticleChatTurn.mockResolvedValue({
      reply: 'Lost answer.',
      transcriptMessages: [],
      highlightRanges: [{ startLine: 3, endLine: 3, label: 'Lost evidence' }],
    });
    api.persistChatTurn.mockRejectedValue(new Error('persist failed'));
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

    expect(api.persistChatTurn).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.pagetollm-chat-error').textContent).toBe('persist failed');
    // The question returns to the composer and the optimistic bubble is gone.
    expect(container.querySelector('.pagetollm-chat-composer textarea').value).toBe(
      'Doomed question',
    );
    expect(container.textContent).not.toContain('Lost answer.');
    // Live-painted highlights are reset to the stored selected event.
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
    api.persistChatTurn.mockResolvedValue({
      chat: {
        chatId: 'chat-1',
        events: [
          {
            seq: 2,
            eventType: 'highlight_span',
            data: { startLine: 3, endLine: 3, label: 'New evidence' },
          },
        ],
      },
      messages: [
        { id: 'm-3', role: 'user', content: 'What about line three?' },
        { id: 'm-4', role: 'assistant', content: 'Line three answers it.' },
      ],
      events: [
        {
          seq: 2,
          eventType: 'highlight_span',
          data: { startLine: 3, endLine: 3, label: 'New evidence' },
        },
      ],
    });
    // Mount lists chats once (resolves); the post-turn refresh is the second
    // call and rejects — the round-trip fails after the turn was persisted.
    api.listStoredChats
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

    expect(api.persistChatTurn).toHaveBeenCalledTimes(1);
    // No rollback and no error banner: the refresh failure is swallowed.
    expect(container.querySelector('.pagetollm-chat-error')).toBeNull();
    expect(container.querySelector('.pagetollm-chat-composer textarea').value).toBe('');
    // The adopted assistant reply stays visible.
    expect(container.textContent).toContain('Line three answers it.');

    unmount();
  });
});
