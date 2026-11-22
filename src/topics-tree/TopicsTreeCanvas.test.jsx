// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import TopicsTreeCanvas from './TopicsTreeCanvas.jsx';
import { pointTreeTools } from '../chat/pointTreeTool.js';
import { buildSummaryTreeDisplayTree, buildTopicsDisplayTree, passageKey } from './displayTree.js';

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

it('reveals a hidden descendant and its source text through @point', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const node = (id, children) => ({
    id,
    title: id,
    kind: 'topic',
    children,
    sentences: [1],
    segments: [{ text: id + ' summary' }],
  });
  const tree = buildSummaryTreeDisplayTree({
    rootId: 'parent',
    nodes: {
      parent: node('parent', ['child']),
      child: node('child', ['last']),
      last: { ...node('last', []), kind: 'passage' },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() => root.render(createElement(TopicsTreeCanvas, { tree, sentences: ['Source.'] })));
    const run = pointTreeTools('@point')[0].run;
    const discovery = await run({ query: 'last' });
    const target = JSON.parse(
      discovery
        .split('\n')
        .find((line) => line.startsWith('{') && JSON.parse(line).title === 'last'),
    );
    await act(async () => {
      await run({ nodeKey: target.key });
    });
    expect(
      [...container.querySelectorAll('.tt-node__title')].some((el) => el.textContent === 'last'),
    ).toBe(true);
    await act(async () => {
      await run({ nodeKey: tree.children[0].textCard.key });
    });
    expect(container.querySelector('.tt-card.is-selected .tt-card__title').textContent).toBe(
      'Source text',
    );
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('scales topic and source-card titles on zoom-out with larger caps for higher-level nodes', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const widthSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function () {
      if (this.classList?.contains('tt-card')) return 360;
      if (this.classList?.contains('tt-node')) {
        return this.querySelector('.tt-node__prose') ? 400 : 200;
      }
      return 0;
    });
  const heightSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function () {
      if (this.classList?.contains('tt-card')) return 220;
      if (this.classList?.contains('tt-node')) {
        return this.querySelector('.tt-node__prose') ? 100 : 44;
      }
      return 0;
    });
  const tree = buildSummaryTreeDisplayTree(
    {
      rootId: 'root',
      nodes: {
        root: {
          id: 'root',
          title: 'Article Overview',
          kind: 'root',
          children: ['branch', 'other'],
          sentences: [1, 2, 3, 4, 5, 6],
          segments: [{ text: 'Root summary.' }],
        },
        branch: {
          id: 'branch',
          title: 'Main Branch',
          kind: 'topic',
          children: ['p1', 'p2', 'p3', 'p4'],
          sentences: [1, 2, 3, 4, 5],
          segments: [{ text: 'Branch summary.' }],
        },
        p1: { id: 'p1', title: 'Passage One', kind: 'passage', children: [], sentences: [1, 2] },
        p2: { id: 'p2', title: 'Passage Two', kind: 'passage', children: [], sentences: [3] },
        p3: { id: 'p3', title: 'Passage Three', kind: 'passage', children: [], sentences: [4] },
        p4: { id: 'p4', title: 'Passage Four', kind: 'passage', children: [], sentences: [5] },
        other: {
          id: 'other',
          title: 'Side Topic',
          kind: 'topic',
          children: ['p5'],
          sentences: [6],
          segments: [{ text: 'Side summary.' }],
        },
        p5: { id: 'p5', title: 'Passage Five', kind: 'passage', children: [], sentences: [6] },
      },
    },
    { title: 'Article Overview' },
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, {
          tree,
          sentences: ['S1.', 'S2.', 'S3.', 'S4.', 'S5.', 'S6.'],
        }),
      ),
    );
    const findNode = (title) =>
      [...container.querySelectorAll('.tt-node')].find(
        (el) => el.querySelector('.tt-node__title').textContent === title,
      );

    act(() => findNode('Main Branch').click());
    act(() => findNode('Passage One').click());

    const stage = container.querySelector('.tt-stage');
    const canvas = container.querySelector('.tt-canvas');
    act(() =>
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 400 }),
      ),
    );

    expect(stage.classList.contains('is-title-zoomed')).toBe(true);
    expect(Number(stage.style.getPropertyValue('--tt-title-zoom'))).toBeGreaterThan(1);
    expect(Number(stage.style.getPropertyValue('--tt-container-zoom'))).toBeGreaterThan(1);

    const rootNode = container.querySelector('.tt-node--root');
    const branchNode = findNode('Main Branch');
    const middleSibling = findNode('Passage Two');
    expect(rootNode.style.getPropertyValue('--tt-node-width')).toBe('400px');
    expect(rootNode.querySelector('.tt-node__zoom-title').textContent).toBe('Article Overview');
    expect(branchNode.querySelector('.tt-node__zoom-title').textContent).toBe('Main Branch');
    expect(rootNode.style.getPropertyValue('--tt-title-width')).not.toBe('');
    expect(rootNode.style.getPropertyValue('--tt-title-lines')).toBe('3');
    expect(
      Number.parseFloat(branchNode.style.getPropertyValue('--tt-title-width-cap')),
    ).toBeGreaterThan(
      Number.parseFloat(middleSibling.style.getPropertyValue('--tt-title-width-cap')),
    );
    expect(
      Number.parseFloat(middleSibling.style.getPropertyValue('--tt-title-height-cap')),
    ).toBeGreaterThan(15);

    const card = container.querySelector('.tt-card');
    expect(card.style.getPropertyValue('--tt-card-width')).toBe('360px');
    expect(card.querySelector('.tt-card__zoom-kicker').textContent).toBe('Source');
    expect(card.querySelector('.tt-card__zoom-heading').textContent).toBe(
      'Main Branch > Passage One',
    );
    expect(Number.parseFloat(card.style.getPropertyValue('--tt-title-width-cap'))).toBeGreaterThan(
      14,
    );
    expect(Number.parseFloat(card.style.getPropertyValue('--tt-title-height-cap'))).toBeGreaterThan(
      14,
    );

    // Clicking a zoomed-out topic node still toggles expansion, and clicking a card selects it.
    act(() => card.querySelector('.tt-card__zoom-title').click());
    expect(card.classList.contains('is-selected')).toBe(true);
    expect(findNode('Passage Two').getAttribute('aria-expanded')).toBe('false');
    act(() => findNode('Passage Two').click());
    expect(container.querySelectorAll('.tt-card')).toHaveLength(2);
  } finally {
    widthSpy.mockRestore();
    heightSpy.mockRestore();
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it('hides inactive overview controls from tab order, preserves card move/resize drags, and avoids mutating sibling nodes during drags', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const widthSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function () {
      if (this.classList?.contains('tt-card')) return 360;
      if (this.classList?.contains('tt-node')) return 400;
      return 0;
    });
  const heightSpy = vi
    .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
    .mockImplementation(function () {
      if (this.classList?.contains('tt-card')) return 220;
      if (this.classList?.contains('tt-node')) return 100;
      return 0;
    });
  const tree = buildSummaryTreeDisplayTree(
    {
      rootId: 'root',
      nodes: {
        root: {
          id: 'root',
          title: 'Overview',
          kind: 'root',
          children: ['branch'],
          sentences: [1],
          segments: [{ text: 'Shared summary.' }],
        },
        branch: {
          id: 'branch',
          title: 'Branch',
          kind: 'passage',
          children: [],
          sentences: [1],
          segments: [{ text: 'Shared summary.' }],
        },
      },
    },
    { title: 'Overview' },
  );
  const style = document.createElement('style');
  style.textContent = readFileSync('src/topics-tree/topics-tree.css', 'utf8');
  document.head.appendChild(style);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        createElement(TopicsTreeCanvas, {
          tree,
          sentences: ['Source sentence.'],
          onShowInPage: vi.fn(),
        }),
      ),
    );
    const branchNode = [...container.querySelectorAll('.tt-node')].find(
      (el) => el.querySelector('.tt-node__title').textContent === 'Branch',
    );
    act(() => branchNode.click());

    const canvas = container.querySelector('.tt-canvas');
    act(() =>
      canvas.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 400 }),
      ),
    );

    const rootNode = container.querySelector('.tt-node--root');
    const card = container.querySelector('.tt-card');
    expect(card.getAttribute('aria-label')).toBe('Source: Branch');

    // Hidden controls inside overview nodes/cards are visibility: hidden (out of tab order),
    // while topic titles are not visibility-hidden (keeping their accessible name) and card resize stays active.
    const rootTitleStyle = getComputedStyle(rootNode.querySelector('.tt-node__title'));
    expect(rootTitleStyle.visibility).not.toBe('hidden');
    expect(rootTitleStyle.opacity).toBe('0');
    expect(getComputedStyle(rootNode.querySelector('.tt-node__meta')).visibility).toBe('hidden');
    expect(getComputedStyle(branchNode.querySelector('.tt-node__summary-toggle')).visibility).toBe(
      'hidden',
    );
    expect(getComputedStyle(card.querySelector('.tt-card__body')).visibility).toBe('hidden');
    const resizeHandle = card.querySelector('.tt-card__resize');
    expect(getComputedStyle(resizeHandle).visibility).not.toBe('hidden');
    expect(getComputedStyle(resizeHandle).pointerEvents).not.toBe('none');

    // Moving a card via its zoomed-out overview title updates only the card without mutating sibling nodes.
    const siblingMutations = [];
    const observer = new MutationObserver((records) => siblingMutations.push(...records));
    observer.observe(rootNode, { attributes: true, subtree: true });

    const beforeX = Number.parseFloat(card.style.getPropertyValue('--tt-x'));
    const beforeY = Number.parseFloat(card.style.getPropertyValue('--tt-y'));
    act(() => {
      card
        .querySelector('.tt-card__zoom-title')
        .dispatchEvent(
          new PointerEvent('pointerdown', { button: 0, clientX: 100, clientY: 100, bubbles: true }),
        );
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 160, clientY: 130, bubbles: true }),
      );
    });
    expect(Number.parseFloat(card.style.getPropertyValue('--tt-x'))).toBeGreaterThan(beforeX);
    expect(Number.parseFloat(card.style.getPropertyValue('--tt-y'))).toBeGreaterThan(beforeY);
    expect(observer.takeRecords()).toHaveLength(0);
    expect(siblingMutations).toHaveLength(0);
    observer.disconnect();
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });

    // Resizing via the visible corner handle updates the card's zoomed width & dimensions.
    act(() => {
      resizeHandle.dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, clientX: 200, clientY: 200, bubbles: true }),
      );
    });
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 280, clientY: 250, bubbles: true }),
      );
    });
    expect(Number.parseFloat(card.style.getPropertyValue('--tt-card-width'))).toBeGreaterThan(360);
    expect(Number.parseFloat(card.style.height)).toBeGreaterThan(220);
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
  } finally {
    widthSpy.mockRestore();
    heightSpy.mockRestore();
    act(() => root.unmount());
    container.remove();
    style.remove();
    vi.unstubAllGlobals();
  }
});
