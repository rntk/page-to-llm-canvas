// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceCardChatDrawer } from './SourceCardChatDrawer.jsx';

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

const card = {
  chatKey: 'card:2-2:rec',
  title: 'Fruit facts',
  url: 'https://a.test/fruit',
  contentRevision: 'rev-1',
  cardSentences: ['Apples are red.'],
  pageSentences: ['Fruit intro.', 'Apples are red.', 'Bananas are yellow.'],
};

function makePorts(runTurn) {
  return {
    chatRepository: {
      list: vi.fn(async () => []),
      get: vi.fn(),
      append: vi.fn(async (key, chatId, turn) => ({
        chat: { chatId: 'chat-1', messages: turn.messages, events: [], scope: [] },
      })),
      remove: vi.fn(),
    },
    runTurn,
    getChatLimits: vi.fn(async () => ({ maxChunkChars: 4000, maxHistoryChars: 500 })),
  };
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });

describe('SourceCardChatDrawer', () => {
  it('chats over the card text with tools that read and search the whole article', async () => {
    let received;
    const runTurn = vi.fn(async (args) => {
      received = args;
      return { reply: 'Answer', highlightRanges: [] };
    });
    const ports = makePorts(runTurn);
    await act(async () =>
      root.render(<SourceCardChatDrawer card={card} onClose={() => {}} chatPorts={ports} />),
    );
    await flush();

    expect(container.querySelector('aside').getAttribute('aria-label')).toContain('Fruit facts');
    expect(container.textContent).toContain('read and search the rest of the article');

    const textarea = container.querySelector('.pagetollm-chat-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    act(() => {
      setter.call(textarea, 'What colour?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.pagetollm-chat-composer button').click());
    await flush();

    expect(ports.chatRepository.list).toHaveBeenCalledWith('card:2-2:rec');
    expect(received.article).toMatchObject({
      sentences: ['Apples are red.'],
      source: { kind: 'excerpt', pageTitle: 'Fruit facts', pageUrl: 'https://a.test/fruit' },
    });
    expect(received.tools.map((tool) => tool.definition.name)).toEqual([
      'read_page',
      'search_page',
    ]);

    const search = JSON.parse(
      await received.tools[1].run({ query: 'bananas' }, { maxChars: 5000 }),
    );
    expect(search.matches).toEqual([{ line: 3, text: 'Bananas are yellow.' }]);
    const read = JSON.parse(await received.tools[0].run({}, { maxChars: 5000 }));
    expect(read).toMatchObject({ excerptStartsAtLine: 2, startLine: 1, totalLines: 3 });
  });
});
