// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import {
  buildSummaryTreeDisplayTree,
  buildTopicsDisplayTree,
  passageKey,
} from './topicsTreeModel.js';

it('reveals a repeated summary locally and remembers it across branch folding', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const node = (id, children) => ({
    id,
    title: id,
    kind: 'topic',
    children,
    sentences: [1],
    segments: [{ text: 'Shared summary.' }],
  });
  const tree = buildSummaryTreeDisplayTree({
    rootId: 'parent',
    nodes: {
      parent: node('parent', ['child']),
      child: node('child', ['last']),
      last: node('last', []),
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(TopicsTreeCanvas, { tree, sentences: ['Source.'] })));
    const parent = () => container.querySelector('.tt-node--root');
    const child = () =>
      [...container.querySelectorAll('.tt-node')].find(
        (el) => el.querySelector('.tt-node__title').textContent === 'child',
      );
    const button = () => child().querySelector('.tt-node__summary-toggle button');
    const prose = () => child().querySelector('.tt-node__prose');
    expect(parent().querySelector('.tt-node__prose').hidden).toBe(false);
    expect(prose().hidden).toBe(true);
    expect(button().getAttribute('aria-expanded')).toBe('false');
    act(() => button().click());
    expect(prose().hidden).toBe(false);
    expect(button().textContent).toBe('Hide summary');
    expect(button().getAttribute('aria-controls')).toBe(prose().id);
    expect(child().getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelectorAll('.tt-node')).toHaveLength(2);
    act(() => parent().click());
    act(() => parent().click());
    expect(prose().hidden).toBe(false);
    act(() => button().click());
    expect(prose().hidden).toBe(true);
    act(() => child().click());
    expect(container.querySelectorAll('.tt-node')).toHaveLength(3);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('gives source cards a Chat tab that unfolds and folds their chat', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const tree = buildSummaryTreeDisplayTree({
    rootId: 'root',
    nodes: {
      root: {
        id: 'root',
        title: 'root',
        kind: 'topic',
        children: ['p1', 'p2'],
        sentences: [1, 2],
        segments: [{ text: 'Root summary.' }],
      },
      p1: { id: 'p1', title: 'one', kind: 'passage', children: [], sentences: [1] },
      p2: { id: 'p2', title: 'two', kind: 'passage', children: [], sentences: [2] },
    },
  });
  // Only the first card can chat.
  const leafChat = {
    available: (node) => node.sentences[0] === 1,
    render: (node, { onClose }) =>
      createElement(
        'aside',
        { className: 'fake-chat' },
        createElement('button', { className: 'fake-close', onClick: onClose }, 'close'),
      ),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, { tree, sentences: ['First.', 'Second.'], leafChat }),
      ),
    );
    container
      .querySelectorAll('.tt-node:not(.tt-node--root)')
      .forEach((node) => act(() => node.click()));
    const folds = () => container.querySelectorAll('.tt-card__chat-fold');
    expect(container.querySelectorAll('.tt-card')).toHaveLength(2);
    expect(folds()).toHaveLength(1);
    expect(container.querySelector('.fake-chat')).toBeNull();

    act(() => folds()[0].click());
    expect(container.querySelector('.fake-chat')).not.toBeNull();
    expect(folds()[0].getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.tt-card.is-chat-open')).not.toBeNull();

    act(() => folds()[0].click());
    expect(container.querySelector('.fake-chat')).toBeNull();

    act(() => folds()[0].click());
    act(() => container.querySelector('.fake-close').click());
    expect(container.querySelector('.fake-chat')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('marks the passages its chat highlights and clears them', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const tree = buildTopicsDisplayTree([{ name: 'First', sentences: [1, 2] }]);
  let handlers;
  const leafChat = {
    available: () => true,
    render: (_node, props) => {
      handlers = props;
      return createElement('aside', { className: 'fake-chat' });
    },
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, { tree, sentences: ['First.', 'Second.'], leafChat }),
      ),
    );
    container
      .querySelectorAll('.tt-node:not(.tt-node--root)')
      .forEach((node) => act(() => node.click()));
    act(() => container.querySelector('.tt-card__chat-fold').click());
    const marked = () =>
      Array.from(container.querySelectorAll('.tt-passages li.is-chat-highlighted')).map(
        (li) => li.textContent,
      );
    expect(marked()).toEqual([]);

    act(() => handlers.onHighlightLines([passageKey('', 2)], { focus: false }));
    expect(marked()).toEqual(['Second.']);

    act(() => handlers.onClearHighlights());
    expect(marked()).toEqual([]);
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('shows no Chat tab without leafChat', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const tree = buildSummaryTreeDisplayTree({
    rootId: 'root',
    nodes: {
      root: { id: 'root', title: 'root', kind: 'passage', children: [], sentences: [1] },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(TopicsTreeCanvas, { tree, sentences: ['First.'] })));
    expect(container.querySelector('.tt-card__chat-fold')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('brings the selected card above other open chats regardless of DOM order', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const tree = buildTopicsDisplayTree([
    { name: 'First', sentences: [1] },
    { name: 'Second', sentences: [2] },
  ]);
  const leafChat = {
    available: () => true,
    render: () => createElement('aside', { className: 'fake-chat' }),
  };
  const style = document.createElement('style');
  style.textContent = readFileSync('src/topics-tree/topics-tree.css', 'utf8');
  document.head.appendChild(style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, { tree, sentences: ['First.', 'Second.'], leafChat }),
      ),
    );
    container
      .querySelectorAll('.tt-node:not(.tt-node--root)')
      .forEach((node) => act(() => node.click()));
    const cards = container.querySelectorAll('.tt-card');
    expect(cards).toHaveLength(2);
    cards.forEach((card) => act(() => card.querySelector('.tt-card__chat-fold').click()));
    expect(container.querySelectorAll('.tt-card.is-chat-open')).toHaveLength(2);
    const zIndex = (card) => Number(getComputedStyle(card).zIndex);
    expect(zIndex(cards[1])).toBeGreaterThan(zIndex(cards[0]));

    act(() => cards[0].click());
    expect(cards[0].classList.contains('is-front')).toBe(true);
    expect(cards[1].classList.contains('is-front')).toBe(false);
    expect(zIndex(cards[0])).toBeGreaterThan(zIndex(cards[1]));
    expect(container.querySelectorAll('.fake-chat')).toHaveLength(2);
  } finally {
    act(() => root.unmount());
    container.remove();
    style.remove();
    vi.unstubAllGlobals();
  }
});

it('shows a topic’s whole source text as sections in place of its branches, with a Chat tab', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const tree = buildTopicsDisplayTree(
    [
      { name: 'Fruit>Apples', sentences: [1] },
      { name: 'Fruit>Pears', sentences: [2] },
    ],
    null,
    { title: 'site' },
  );
  const leafChat = {
    available: (node) => node.key === 'text:topic:Fruit',
    render: () => createElement('aside', { className: 'fake-chat' }),
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, { tree, sentences: ['Apples.', 'Pears.'], leafChat }),
      ),
    );
    act(() => container.querySelector('.tt-node--topic').click());
    expect(container.querySelectorAll('.tt-node--topic')).toHaveLength(3);
    const toggle = () =>
      [...container.querySelectorAll('.tt-node--topic')[0].querySelectorAll('button')].find(
        (button) => button.textContent === 'Source text',
      );

    act(() => toggle().click());
    expect(container.querySelectorAll('.tt-node--topic')).toHaveLength(1);
    const card = container.querySelector('.tt-card');
    expect(card.querySelector('.tt-card__title').textContent).toBe('Source text');
    expect([...card.querySelectorAll('.tt-text-section__title')].map((h) => h.textContent)).toEqual(
      ['1. Fruit > Apples', '2. Fruit > Pears'],
    );
    expect(card.textContent).toContain('Apples.');
    expect(card.textContent).toContain('Pears.');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    act(() => card.querySelector('.tt-card__chat-fold').click());
    expect(container.querySelector('.fake-chat')).not.toBeNull();

    act(() => toggle().click());
    expect(container.querySelector('.tt-card')).toBeNull();
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
