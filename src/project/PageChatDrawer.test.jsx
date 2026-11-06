// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageChatDrawer } from './PageChatDrawer.jsx';

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const tab = { id: 7, title: 'Docs', url: 'https://a.test/docs' };

function makePorts() {
  return {
    chatRepository: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      append: vi.fn(async (key, chatId, turn) => ({
        chat: { chatId: 'chat-1', messages: turn.messages, events: [], scope: [] },
      })),
      remove: vi.fn(),
    },
    runTurn: vi.fn(async () => ({ reply: 'Answer', highlightRanges: [] })),
    getChatLimits: vi.fn(async () => ({ maxChunkChars: 1000, maxHistoryChars: 500 })),
  };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function render(api, chatPorts = makePorts()) {
  await act(async () =>
    root.render(
      <PageChatDrawer
        projectId="p1"
        tab={tab}
        api={api}
        onClose={() => {}}
        chatPorts={chatPorts}
      />,
    ),
  );
  await flush();
  return chatPorts;
}

async function send(text) {
  const textarea = container.querySelector('.pagetollm-chat-composer textarea');
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  act(() => {
    setter.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('.pagetollm-chat-composer button').click());
  await flush();
}

describe('PageChatDrawer', () => {
  it('chats against the saved record, sharing its history key and topics', async () => {
    const api = {
      getPageChat: vi.fn(async () => ({
        source: {
          kind: 'record',
          key: 'rec-1',
          url: tab.url,
          sentences: ['First.', 'Second.'],
          topics: [{ name: 'Intro', sentences: [1] }],
          contentRevision: 'rev-1',
        },
      })),
      capturePageText: vi.fn(),
    };
    const ports = await render(api);
    expect(api.getPageChat).toHaveBeenCalledWith('p1', 7);
    expect(ports.chatRepository.list).toHaveBeenCalledWith('rec-1');
    expect(container.textContent).toContain('Choose topics');

    await send('What is first?');
    expect(api.capturePageText).not.toHaveBeenCalled();
    expect(ports.runTurn.mock.calls[0][0].article.sentences).toEqual(['First.', 'Second.']);
    expect(ports.chatRepository.append.mock.calls[0][0]).toBe('rec-1');
    expect(ports.chatRepository.append.mock.calls[0][3]).toEqual({
      expectedContentRevision: 'rev-1',
    });
  });

  it('reads an unsaved page from the tab once, on the first send', async () => {
    const api = {
      getPageChat: vi.fn(async () => ({
        source: { kind: 'page', key: 'page:https://a.test/docs', url: tab.url },
      })),
      capturePageText: vi.fn(async () => ({ sentences: ['Live text.'], truncated: false })),
    };
    const ports = await render(api);
    expect(ports.chatRepository.list).toHaveBeenCalledWith('page:https://a.test/docs');
    expect(container.textContent).not.toContain('Choose topics');
    expect(api.capturePageText).not.toHaveBeenCalled();

    await send('Summarize');
    await send('More');
    expect(api.capturePageText).toHaveBeenCalledTimes(1);
    expect(api.capturePageText).toHaveBeenCalledWith('p1', 7);
    expect(ports.runTurn.mock.calls.map((call) => call[0].article.sentences)).toEqual([
      ['Live text.'],
      ['Live text.'],
    ]);
  });

  it('surfaces a failed tab read and retries it on the next send', async () => {
    const api = {
      getPageChat: vi.fn(async () => ({
        source: { kind: 'page', key: 'page:https://a.test/docs', url: tab.url },
      })),
      capturePageText: vi
        .fn()
        .mockRejectedValueOnce(new Error('Could not read this tab.'))
        .mockResolvedValueOnce({ sentences: ['Loaded.'], truncated: false }),
    };
    const ports = await render(api);
    await send('Hi');
    expect(container.textContent).toContain('Could not read this tab.');
    expect(ports.runTurn).not.toHaveBeenCalled();
    await send('Hi');
    expect(api.capturePageText).toHaveBeenCalledTimes(2);
    expect(ports.runTurn).toHaveBeenCalledTimes(1);
  });

  it('explains pages that cannot chat yet or at all', async () => {
    const api = {
      getPageChat: vi
        .fn()
        .mockResolvedValueOnce({
          source: { kind: 'record', key: 'rec-1', url: tab.url, sentences: [], topics: [] },
        })
        .mockResolvedValueOnce({
          source: { kind: 'unsupported', url: 'chrome://x', reason: 'Not here.' },
        }),
      capturePageText: vi.fn(),
    };
    await render(api);
    expect(container.textContent).toContain('still being processed');
    await act(async () => container.querySelector('.page-chat-note button').click());
    await flush();
    expect(container.textContent).toContain('Not here.');
  });

  it('offers a retry when the source cannot be resolved', async () => {
    const api = {
      getPageChat: vi
        .fn()
        .mockRejectedValueOnce(new Error('tab is not in this project'))
        .mockResolvedValueOnce({
          source: { kind: 'unsupported', url: 'chrome://x', reason: 'Not here.' },
        }),
      capturePageText: vi.fn(),
    };
    await render(api);
    expect(container.querySelector('[role="alert"]').textContent).toContain(
      'tab is not in this project',
    );
    await act(async () => container.querySelector('.page-chat-note button').click());
    await flush();
    expect(api.getPageChat).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Not here.');
  });
});
