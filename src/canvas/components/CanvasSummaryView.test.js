// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import React, { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createCardElementRegistry } from '../hooks/useSummaryCardRegistry.js';
import CanvasSummaryView from './CanvasSummaryView.jsx';

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
    rerender(newElement) {
      act(() => root.render(newElement));
    },
  };
}

// Built on the production factory so the double cannot drift from the real
// registry's behavior; `elements` just exposes the backing store for assertions.
function createCardRegistry() {
  const store = { current: {} };
  return { ...createCardElementRegistry(store), elements: store.current };
}

function createProps(overrides = {}) {
  return {
    cards: [],
    activeTopic: null,
    hoveredTopic: null,
    cardRegistry: createCardRegistry(),
    contentRef: React.createRef(),
    onTopicEnter: vi.fn(),
    onTopicLeave: vi.fn(),
    onShowSource: vi.fn(),
    source: { html: '', sentences: [], sourceUrl: null },
    ...overrides,
  };
}

describe('CanvasSummaryView', () => {
  const mockCards = [
    {
      key: 'card1',
      path: 'Topic A > Subtopic B',
      text: 'This is a summary of B',
      sourceSentences: [0, 1, 2],
      startSentence: 0,
    },
    {
      key: 'card2',
      path: 'Topic C',
      text: '',
      sourceSentences: [],
      startSentence: 5,
    },
  ];

  it('renders empty state when cards is empty', () => {
    const contentRef = React.createRef();
    const { container, unmount } = render(
      createElement(CanvasSummaryView, createProps({ contentRef })),
    );

    const emptyMsg = container.querySelector('.canvas-summary-view__empty');
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg.textContent).toContain('No summaries available');
    expect(contentRef.current).not.toBeNull();

    unmount();
  });

  it('renders summary cards and triggers callbacks', () => {
    vi.useFakeTimers();
    const onTopicEnter = vi.fn();
    const onTopicLeave = vi.fn();
    const onShowSource = vi.fn();
    const cardRegistry = createCardRegistry();
    const contentRef = React.createRef();

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards: mockCards,
          activeTopic: { path: 'Topic A > Subtopic B', cardKey: 'card1' },
          cardRegistry,
          contentRef,
          onTopicEnter,
          onTopicLeave,
          onShowSource,
        }),
      ),
    );

    expect(contentRef.current).not.toBeNull();
    expect(Object.keys(cardRegistry.elements)).toContain('card1');
    expect(Object.keys(cardRegistry.elements)).toContain('card2');

    const articles = container.querySelectorAll('.canvas-summary-view__card');
    expect(articles).toHaveLength(2);

    // card1 is active
    expect(articles[0].className).toContain('is-active');
    expect(articles[1].className).not.toContain('is-active');

    // test hover trigger — the hovered-topic key is now deferred through the same
    // settle delay as the preview, so it fires after the debounce, not on enter.
    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true });
    act(() => {
      articles[0].dispatchEvent(mouseOverEvent);
    });
    expect(onTopicEnter).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(onTopicEnter).toHaveBeenCalledWith({ path: 'Topic A > Subtopic B', cardKey: 'card1' });

    // The parent owns conditional clearing for a leave intent.
    onTopicLeave.mockClear();
    const mouseOutEvent = new MouseEvent('mouseout', { bubbles: true });
    act(() => {
      articles[0].dispatchEvent(mouseOutEvent);
    });
    expect(onTopicLeave).toHaveBeenCalledWith({ path: 'Topic A > Subtopic B', cardKey: 'card1' });

    // Show source sentences click and stopPropagation
    const button = container.querySelector('.canvas-summary-view__summary-tooltip-button');
    expect(button).not.toBeNull();

    const onMouseDownEvent = new MouseEvent('mousedown', { bubbles: true });
    vi.spyOn(onMouseDownEvent, 'stopPropagation');
    act(() => {
      button.dispatchEvent(onMouseDownEvent);
    });
    expect(onMouseDownEvent.stopPropagation).toHaveBeenCalled();

    const onClickEvent = new MouseEvent('click', { bubbles: true });
    vi.spyOn(onClickEvent, 'stopPropagation');
    act(() => {
      button.dispatchEvent(onClickEvent);
    });
    expect(onClickEvent.stopPropagation).toHaveBeenCalled();
    expect(onShowSource).toHaveBeenCalledWith(mockCards[0]);

    unmount();
    // refs should be deleted on unmount
    expect(cardRegistry.elements).toEqual({});
    vi.useRealTimers();
  });

  it('renders a floating source preview with highlighted original sentences on hover', () => {
    vi.useFakeTimers();
    const cardRegistry = createCardRegistry();
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'Summary',
        sourceSentences: [0, 1],
        startSentence: 0,
      },
    ];

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards,
          cardRegistry,
          source: {
            html: '<article><h2>Original heading</h2><p>Alpha sentence. <strong>Beta sentence.</strong> Gamma sentence.</p></article>',
            sentences: ['Alpha sentence.', 'Beta sentence.', 'Gamma sentence.'],
          },
        }),
      ),
    );

    act(() => {
      container
        .querySelector('.canvas-summary-view__card')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // The preview opens after a short hover-settle delay (debounced to avoid
    // rebuilding it for every card crossed during a fast sweep).
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview).not.toBeNull();
    expect(preview.parentElement.classList.contains('canvas-summary-view')).toBe(false);
    expect(preview.style.position).toBe('absolute');
    expect(preview.style.left).not.toBe('');
    expect(preview.textContent).toContain('Alpha sentence.');
    expect(preview.textContent).toContain('Beta sentence.');
    expect(preview.textContent).not.toContain('Gamma sentence.');
    expect(preview.querySelector('strong')).not.toBeNull();
    expect(preview.querySelectorAll('.canvas-summary-source-preview__highlight')).toHaveLength(2);

    const parentWheelHandler = vi.fn();
    container.addEventListener('wheel', parentWheelHandler);
    act(() => {
      preview.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    });
    expect(parentWheelHandler).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();
  });

  it('renders neighboring topic sentences while highlighting only the active topic', () => {
    const cardRegistry = createCardRegistry();
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'Summary',
        sourceSentences: [1],
        startSentence: 1,
      },
      {
        key: 'card2',
        path: 'Topic B',
        text: 'Other summary',
        sourceSentences: [2],
        startSentence: 2,
      },
    ];

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards,
          activeTopic: { path: 'Topic B', cardKey: 'card2' },
          cardRegistry,
          source: {
            html: '<p>Alpha sentence. Beta sentence.</p>',
            sentences: ['Alpha sentence.', 'Beta sentence.'],
          },
        }),
      ),
    );

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview).not.toBeNull();
    expect(preview.textContent).toContain('Alpha sentence.');
    expect(preview.textContent).toContain('Beta sentence.');
    const highlights = preview.querySelectorAll('.canvas-summary-source-preview__highlight');
    expect(highlights).toHaveLength(1);
    expect(highlights[0].textContent).toBe('Beta sentence.');

    unmount();
  });

  it('includes previous and next summary topics as unhighlighted preview context', () => {
    vi.useFakeTimers();
    const cardRegistry = createCardRegistry();
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'Previous summary',
        sourceSentences: [0],
        startSentence: 0,
      },
      {
        key: 'card2',
        path: 'Topic B',
        text: 'Current summary',
        sourceSentences: [1],
        startSentence: 1,
      },
      {
        key: 'card3',
        path: 'Topic C',
        text: 'Next summary',
        sourceSentences: [2],
        startSentence: 2,
      },
      {
        key: 'card4',
        path: 'Topic D',
        text: 'Outside summary',
        sourceSentences: [3],
        startSentence: 3,
      },
    ];

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards,
          cardRegistry,
          source: {
            html: '<article><p>Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.</p></article>',
            sentences: ['Alpha sentence.', 'Beta sentence.', 'Gamma sentence.', 'Delta sentence.'],
          },
        }),
      ),
    );

    act(() => {
      container
        .querySelectorAll('.canvas-summary-view__card')[1]
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    // The preview opens after a short hover-settle delay.
    act(() => {
      vi.advanceTimersByTime(120);
    });

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview).not.toBeNull();
    expect(preview.textContent).toContain('Alpha sentence.');
    expect(preview.textContent).toContain('Beta sentence.');
    expect(preview.textContent).toContain('Gamma sentence.');
    expect(preview.textContent).not.toContain('Delta sentence.');
    const highlights = preview.querySelectorAll('.canvas-summary-source-preview__highlight');
    expect(highlights).toHaveLength(1);
    expect(highlights[0].textContent).toBe('Beta sentence.');

    unmount();
    vi.useRealTimers();
  });

  it('updates the preview from topic hover even when another summary was clicked', () => {
    const cardRegistry = createCardRegistry();
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'First summary',
        sourceSentences: [0],
        startSentence: 0,
      },
      {
        key: 'card2',
        path: 'Topic B',
        text: 'Second summary',
        sourceSentences: [1],
        startSentence: 1,
      },
    ];

    const props = createProps({
      cards,
      cardRegistry,
      source: {
        html: '<article><p>Alpha sentence. Beta sentence.</p></article>',
        sentences: ['Alpha sentence.', 'Beta sentence.'],
      },
    });

    const { container, rerender, unmount } = render(createElement(CanvasSummaryView, props));

    act(() => {
      container
        .querySelectorAll('.canvas-summary-view__card')[0]
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('.canvas-summary-source-preview').textContent).toContain(
      'Alpha sentence.',
    );

    rerender(
      createElement(CanvasSummaryView, {
        ...props,
        activeTopic: { path: 'Topic B', cardKey: 'card2' },
        hoveredTopic: { path: 'Topic B', cardKey: 'card2' },
      }),
    );

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview.textContent).toContain('Beta sentence.');
    const highlights = preview.querySelectorAll('.canvas-summary-source-preview__highlight');
    expect(highlights).toHaveLength(1);
    expect(highlights[0].textContent).toBe('Beta sentence.');

    unmount();
  });

  it('does not reuse cached preview HTML after the source article changes', () => {
    const cardRegistry = createCardRegistry();
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'Summary',
        sourceSentences: [0],
        startSentence: 0,
      },
    ];
    const props = createProps({
      cards,
      activeTopic: { path: 'Topic A', cardKey: 'card1' },
      cardRegistry,
    });

    const { container, rerender, unmount } = render(
      createElement(CanvasSummaryView, {
        ...props,
        source: { html: '<p>Original sentence.</p>', sentences: ['Original sentence.'] },
      }),
    );

    expect(container.querySelector('.canvas-summary-source-preview').textContent).toContain(
      'Original sentence.',
    );

    rerender(
      createElement(CanvasSummaryView, {
        ...props,
        source: { html: '<p>Updated sentence.</p>', sentences: ['Updated sentence.'] },
      }),
    );

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview.textContent).toContain('Updated sentence.');
    expect(preview.textContent).not.toContain('Original sentence.');

    unmount();
  });

  it('renders a YouTube timestamp link on summary cards for YouTube records', () => {
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'A summary.',
        sourceSentences: [4],
        startSentence: 4,
      },
    ];

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards,
          source: {
            html: '',
            sentences: ['a', 'b', 'c', '0:26 26 seconds Blackwell is a card.'],
            sourceUrl: 'https://www.youtube.com/watch?v=abc',
          },
        }),
      ),
    );

    const link = container.querySelector('a.canvas-youtube-timestamp');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('v=abc');
    expect(link.getAttribute('href')).toContain('&t=26s');
    expect(link.textContent).toContain('0:26');
    unmount();
  });

  it('does not render a YouTube link on summary cards for non-YouTube records', () => {
    const cards = [
      {
        key: 'card1',
        path: 'Topic A',
        text: 'A summary.',
        sourceSentences: [4],
        startSentence: 4,
      },
    ];

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({
          cards,
          source: {
            html: '',
            sentences: ['a', 'b', 'c', '0:26 26 seconds Blackwell is a card.'],
            sourceUrl: 'https://example.com/post',
          },
        }),
      ),
    );

    expect(container.querySelector('a.canvas-youtube-timestamp')).toBeNull();
    unmount();
  });

  it('zooms to a clicked summary card, including cards without source sentences', () => {
    const onZoomToCard = vi.fn();
    const onShowSource = vi.fn();

    const { container, unmount } = render(
      createElement(
        CanvasSummaryView,
        createProps({ cards: mockCards, onZoomToCard, onShowSource }),
      ),
    );

    const articles = container.querySelectorAll('.canvas-summary-view__card');
    act(() => {
      articles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onZoomToCard).toHaveBeenCalledWith(mockCards[0]);

    // The preview handler ignores a card with no source sentences; the zoom
    // must still fire for it.
    act(() => {
      articles[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onZoomToCard).toHaveBeenCalledWith(mockCards[1]);
    expect(onZoomToCard).toHaveBeenCalledTimes(2);

    // The in-card action button stops propagation, so it shows the source
    // without also zooming.
    const button = container.querySelector('.canvas-summary-view__summary-tooltip-button');
    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowSource).toHaveBeenCalledWith(mockCards[0]);
    expect(onZoomToCard).toHaveBeenCalledTimes(2);

    unmount();
  });
});
