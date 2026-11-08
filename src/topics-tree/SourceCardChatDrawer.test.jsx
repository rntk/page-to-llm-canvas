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

  it('reports the passages of a highlighted span, skipping heading lines', async () => {
    const onHighlightLines = vi.fn();
    // Highlights stream while the turn runs; the chat ignores them afterwards.
    const runTurn = vi.fn(async (args) => {
      await args.effects.onHighlight({ startLine: 1, endLine: 2 });
      await args.effects.onHighlight({ startLine: 2, endLine: 3 });
      return { reply: 'Answer', highlightRanges: [] };
    });
    const onClearHighlights = vi.fn();
    const block = {
      chatKey: 'block:abc:rec',
      topic: 'Fruit',
      lineKeys: [null, 'k1', 'k2'],
      cardSentences: ['### Section 1', 'Apples are red.', 'Pears are green.'],
      pages: [
        { title: 'Fruit', url: 'https://a.test/', excerptSentences: [], pageSentences: ['x'] },
      ],
    };
    await act(async () =>
      root.render(
        <SourceCardChatDrawer
          card={block}
          onClose={() => {}}
          onHighlightLines={onHighlightLines}
          onClearHighlights={onClearHighlights}
          chatPorts={makePorts(runTurn)}
        />,
      ),
    );
    await flush();
    const textarea = container.querySelector('.pagetollm-chat-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    act(() => {
      setter.call(textarea, 'Which?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.pagetollm-chat-composer button').click());
    await flush();

    expect(onHighlightLines.mock.calls).toEqual([
      [['k1'], { focus: false }],
      [['k1', 'k2'], { focus: false }],
    ]);
  });

  it('chats over the sections of a topic with page tools that take a page number', async () => {
    let received;
    const runTurn = vi.fn(async (args) => {
      received = args;
      return { reply: 'Answer', highlightRanges: [] };
    });
    const ports = makePorts(runTurn);
    const block = {
      chatKey: 'project:p1:block:abc',
      topic: 'Fruit',
      cardSentences: [
        '### Section 1 - topic: Fruit > Apples - page 1 - page lines 2',
        'Apples are red.',
      ],
      pages: [
        {
          title: 'Fruit facts',
          url: 'https://a.test/fruit',
          excerptSentences: ['Apples are red.'],
          pageSentences: ['Fruit intro.', 'Apples are red.'],
        },
        {
          title: 'Veg facts',
          url: 'https://b.test/veg',
          excerptSentences: [],
          pageSentences: ['Carrots are orange.'],
        },
      ],
    };
    await act(async () =>
      root.render(<SourceCardChatDrawer card={block} onClose={() => {}} chatPorts={ports} />),
    );
    await flush();
    expect(container.querySelector('aside').getAttribute('aria-label')).toContain('Fruit');
    expect(container.textContent).toContain('sub-topics and pages');

    const textarea = container.querySelector('.pagetollm-chat-composer textarea');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    act(() => {
      setter.call(textarea, 'What colour?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => container.querySelector('.pagetollm-chat-composer button').click());
    await flush();

    expect(ports.chatRepository.list).toHaveBeenCalledWith('project:p1:block:abc');
    expect(received.article.source).toMatchObject({ kind: 'sections', topic: 'Fruit' });
    expect(received.article.source.pages).toHaveLength(2);
    const search = JSON.parse(
      await received.tools[1].run({ query: 'carrots', page: 2 }, { maxChars: 5000 }),
    );
    expect(search).toMatchObject({ page: 2, matches: [{ line: 1, text: 'Carrots are orange.' }] });
  });
});
