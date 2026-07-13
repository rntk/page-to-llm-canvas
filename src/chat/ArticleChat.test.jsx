// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listStoredChats: vi.fn(),
  getStoredChat: vi.fn(),
  createStoredChat: vi.fn(),
  persistChatMessage: vi.fn(),
  persistChatEvent: vi.fn(),
  removeStoredChat: vi.fn(),
  removeStoredChatEvent: vi.fn(),
}));

vi.mock('./chatApi.js', () => api);

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
    await Promise.resolve();
    await Promise.resolve();
  });
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
});
