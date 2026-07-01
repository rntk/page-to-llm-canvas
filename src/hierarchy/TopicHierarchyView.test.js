// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import TopicHierarchyView from './TopicHierarchyView.jsx';

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

describe('TopicHierarchyView', () => {
  it('renders empty state when topics is empty', () => {
    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: [],
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
      }),
    );

    const empty = container.querySelector('.th-empty');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('No topics available');
    unmount();
  });

  it('renders tree nodes and leaf rows with correct styling, summaries, and handles clicks', () => {
    const onTopicClick = vi.fn();
    const mockTopics = [
      {
        name: 'Fruit > Apple',
        sentences: [1, 2, 3],
        summary: 'An apple a day',
      },
      {
        name: 'Fruit > Banana',
        sentences: [4, 5],
      },
      {
        name: 'Veggie',
        sentences: [10],
        summary_text: 'Healthy veggie',
      },
    ];

    const mockSummaries = {
      'Fruit>Banana': {
        text: 'Yellow fruit summary',
      },
    };

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: mockSummaries,
        topicSummaryIndex: {},
        selectedTopicPath: 'Fruit>Apple',
        onTopicClick,
      }),
    );

    // root th-root element
    const thRoot = container.querySelector('.th-root');
    expect(thRoot).not.toBeNull();

    // Check veggie (root and leaf)
    const veggieLeaf = container.querySelectorAll('.th-leaf-row')[2];
    expect(veggieLeaf).not.toBeUndefined();
    expect(veggieLeaf.textContent).toContain('Veggie');
    expect(veggieLeaf.textContent).toContain('Healthy veggie');

    // Click on Veggie leaf
    const veggieBtn = veggieLeaf.querySelector('.th-leaf');
    act(() => veggieBtn.click());
    expect(onTopicClick).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ name: 'Veggie' }),
      }),
    );

    // Check Fruit node
    const fruitNode = container.querySelector('.th-node');
    expect(fruitNode).not.toBeNull();
    const fruitLabel = fruitNode.querySelector('.th-node__label');
    expect(fruitLabel.textContent).toContain('Fruit');

    // Click Fruit node
    onTopicClick.mockClear();
    act(() => fruitLabel.click());
    expect(onTopicClick).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ name: 'Fruit' }),
      }),
    );

    // Apple leaf check - selectedTopicPath is "Fruit>Apple" (which matches)
    const appleLeaf = container.querySelectorAll('.th-leaf-row')[0];
    const appleBtn = appleLeaf.querySelector('.th-leaf');
    expect(appleBtn.className).toContain('is-selected');

    // Banana leaf check - summary is looked up
    const bananaLeaf = container.querySelectorAll('.th-leaf-row')[1];
    expect(bananaLeaf.textContent).toContain('Banana');
    expect(bananaLeaf.textContent).toContain('Yellow fruit summary');

    unmount();
  });

  it('folds a non-leaf topic via its toggle without triggering navigation, showing its own summary', () => {
    const onTopicClick = vi.fn();
    const mockTopics = [
      { name: 'Fruit > Apple', sentences: [1, 2] },
      { name: 'Fruit > Banana', sentences: [3] },
      { name: 'Veggie', sentences: [10] },
    ];
    const mockSummaries = {
      Fruit: { text: 'Fruit overview summary' },
    };

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: mockSummaries,
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick,
      }),
    );

    // Leaf topics have no toggle; only the non-leaf "Fruit" node does.
    const toggles = container.querySelectorAll('.th-node__toggle');
    expect(toggles.length).toBe(1);

    // Expanded by default: Apple + Banana leaf rows are visible.
    expect(container.textContent).toContain('Apple');
    expect(container.textContent).toContain('Banana');
    expect(container.querySelector('.th-node--collapsed')).toBeNull();

    // Clicking the toggle folds the branch and must NOT redirect to sentences.
    act(() => toggles[0].click());
    expect(onTopicClick).not.toHaveBeenCalled();

    const collapsed = container.querySelector('.th-node--collapsed');
    expect(collapsed).not.toBeNull();
    // Children are hidden, the node's own summary is shown instead.
    expect(container.textContent).not.toContain('Apple');
    expect(container.textContent).not.toContain('Banana');
    expect(collapsed.textContent).toContain('Fruit overview summary');

    // Clicking again expands it back.
    act(() => container.querySelector('.th-node__toggle').click());
    expect(container.querySelector('.th-node--collapsed')).toBeNull();
    expect(container.textContent).toContain('Apple');

    unmount();
  });

  it('renders youtube icon and timestamp links when isYouTube is true', () => {
    const mockTopics = [
      {
        name: 'Fruit > Apple',
        sentences: [1, 2],
      },
    ];

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
        sentences: [
          '0:10 Intro to apple',
          '0:20 Details about apple',
        ],
      }),
    );

    const youtubeButtons = container.querySelectorAll('.canvas-youtube-timestamp');
    expect(youtubeButtons.length).toBe(2);

    expect(youtubeButtons[0].getAttribute('href')).toContain('t=10s');
    expect(youtubeButtons[0].textContent).toBe('0:00:10');

    expect(youtubeButtons[1].getAttribute('href')).toContain('t=10s');
    expect(youtubeButtons[1].textContent).toBe('0:00:10');

    unmount();
  });

  it('renders youtube icon and timestamp links when isYouTube is true and sentence IDs are zero-based', () => {
    const mockTopics = [
      {
        name: 'Fruit > Apple',
        sentences: [0, 1],
      },
    ];

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
        sentences: [
          '0:10 Intro to apple',
          '0:20 Details about apple',
        ],
      }),
    );

    const youtubeButtons = container.querySelectorAll('.canvas-youtube-timestamp');
    expect(youtubeButtons.length).toBe(2);

    expect(youtubeButtons[0].getAttribute('href')).toContain('t=10s');
    expect(youtubeButtons[0].textContent).toBe('0:00:10');

    expect(youtubeButtons[1].getAttribute('href')).toContain('t=10s');
    expect(youtubeButtons[1].textContent).toBe('0:00:10');

    unmount();
  });

  // happy-dom has no layout engine, so offsetWidth/clientWidth are 0 — stub them
  // per class so the measurement effect actually runs and we can assert the
  // shared --th-card-width math (widest card, capped to the pane, floored).
  function withStubbedWidths({ leaf, label, pane }, fn) {
    const widthFor = (value, el) => (typeof value === 'function' ? value(el) : value);
    const origOffset = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
    const origClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        if (this.classList?.contains('th-leaf')) return widthFor(leaf, this);
        if (this.classList?.contains('th-node__label')) return widthFor(label, this);
        return 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return this.classList?.contains('th-root') ? pane : 0;
      },
    });
    try {
      return fn();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', origOffset);
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClient);
    }
  }

  const widthTopics = [
    { name: 'Parent > Child', sentences: [1] },
    { name: 'Solo', sentences: [2] },
  ];

  function renderWidthTree() {
    return render(
      createElement(TopicHierarchyView, {
        topics: widthTopics,
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
      }),
    );
  }

  it('locks --th-card-width to the widest card when it fits the pane', () => {
    withStubbedWidths({ leaf: 420, label: 250, pane: 1000 }, () => {
      const { container, unmount } = renderWidthTree();
      const root = container.querySelector('.th-root');
      expect(root.style.getPropertyValue('--th-card-width')).toBe('420px');
      unmount();
    });
  });

  it('caps --th-card-width to the pane width when a card is wider than the pane', () => {
    withStubbedWidths({ leaf: 5000, label: 250, pane: 1000 }, () => {
      const { container, unmount } = renderWidthTree();
      const root = container.querySelector('.th-root');
      // cap = pane (1000) - CARD_WIDTH_CAP_INSET (24)
      expect(root.style.getPropertyValue('--th-card-width')).toBe('976px');
      unmount();
    });
  });

  it('remeasures --th-card-width when expanding an initially collapsed branch', () => {
    const controlledTopics = [
      { name: 'Parent > Short', sentences: [1] },
      { name: 'Parent > Very Long Hidden Child', sentences: [2] },
      { name: 'Solo', sentences: [3] },
    ];

    const buildView = (collapsedPaths) =>
      createElement(TopicHierarchyView, {
        topics: controlledTopics,
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
        collapsedPaths,
        onToggleCollapse: vi.fn(),
      });

    withStubbedWidths(
      {
        leaf: (el) => (el.textContent.includes('Very Long Hidden Child') ? 520 : 220),
        label: 180,
        pane: 1000,
      },
      () => {
        const { container, rerender, unmount } = render(buildView(new Set(['Parent'])));
        const root = container.querySelector('.th-root');
        expect(root.style.getPropertyValue('--th-card-width')).toBe('220px');

        rerender(buildView(new Set()));
        expect(root.style.getPropertyValue('--th-card-width')).toBe('520px');

        rerender(buildView(new Set(['Parent'])));
        expect(root.style.getPropertyValue('--th-card-width')).toBe('520px');
        unmount();
      },
    );
  });

  it('triggers onSummaryClick when a leaf summary is clicked or activated by key', () => {
    const onSummaryClick = vi.fn();
    const mockTopics = [
      {
        name: 'Fruit > Apple',
        sentences: [1],
        summary: 'Delicious red apple',
      },
    ];

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
        onSummaryClick,
      }),
    );

    const summaryEl = container.querySelector('.th-leaf-summary');
    expect(summaryEl).not.toBeNull();

    // Click summary
    act(() => {
      summaryEl.click();
    });
    expect(onSummaryClick).toHaveBeenCalledWith({
      path: 'Fruit > Apple',
      text: 'Delicious red apple',
      sourceSentences: [1],
    });

    onSummaryClick.mockClear();

    // Keydown Enter
    const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    act(() => {
      summaryEl.dispatchEvent(enterEvent);
    });
    expect(onSummaryClick).toHaveBeenCalledWith({
      path: 'Fruit > Apple',
      text: 'Delicious red apple',
      sourceSentences: [1],
    });

    unmount();
  });
});
