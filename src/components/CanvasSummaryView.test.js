// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import React, { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
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

  it('renders empty state when summaryViewCards is empty', () => {
    const articleTextRef = React.createRef();
    const { container, unmount } = render(
      createElement(CanvasSummaryView, {
        summaryViewCards: [],
        summaryViewActivePath: null,
        summaryCardRefs: { current: {} },
        setHoveredTopicKey: vi.fn(),
        articleTextRef,
        onShowSourceSentences: vi.fn(),
      }),
    );

    const emptyMsg = container.querySelector('.canvas-summary-view__empty');
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg.textContent).toContain('No summaries available');
    expect(articleTextRef.current).not.toBeNull();

    unmount();
  });

  it('renders summary cards and triggers callbacks', () => {
    const setHoveredTopicKey = vi.fn();
    const onShowSourceSentences = vi.fn();
    const summaryCardRefs = { current: {} };
    const articleTextRef = React.createRef();

    const { container, unmount } = render(
      createElement(CanvasSummaryView, {
        summaryViewCards: mockCards,
        summaryViewActivePath: 'Topic A > Subtopic B',
        summaryCardRefs,
        setHoveredTopicKey,
        articleTextRef,
        onShowSourceSentences,
      }),
    );

    expect(articleTextRef.current).not.toBeNull();
    expect(Object.keys(summaryCardRefs.current)).toContain('card1');
    expect(Object.keys(summaryCardRefs.current)).toContain('card2');

    const articles = container.querySelectorAll('.canvas-summary-view__card');
    expect(articles).toHaveLength(2);

    // card1 is active
    expect(articles[0].className).toContain('is-active');
    expect(articles[1].className).not.toContain('is-active');

    // test hover trigger
    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true });
    act(() => {
      articles[0].dispatchEvent(mouseOverEvent);
    });
    expect(setHoveredTopicKey).toHaveBeenCalledWith('Topic A > Subtopic B');

    // mouse leave trigger: when current hovered equals path
    setHoveredTopicKey.mockClear();
    const mouseOutEvent = new MouseEvent('mouseout', { bubbles: true });
    act(() => {
      articles[0].dispatchEvent(mouseOutEvent);
    });
    const stateUpdater = setHoveredTopicKey.mock.calls[0][0];
    expect(stateUpdater('Topic A > Subtopic B')).toBeNull();
    expect(stateUpdater('Other')).toBe('Other');

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
    expect(onShowSourceSentences).toHaveBeenCalledWith(mockCards[0]);

    unmount();
    // refs should be deleted on unmount
    expect(summaryCardRefs.current).toEqual({});
  });

  it('renders a floating source preview with highlighted original sentences on hover', () => {
    const summaryCardRefs = { current: {} };
    const articleTextRef = React.createRef();
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
      createElement(CanvasSummaryView, {
        summaryViewCards: cards,
        summaryViewActivePath: null,
        summaryCardRefs,
        setHoveredTopicKey: vi.fn(),
        articleTextRef,
        onShowSourceSentences: vi.fn(),
        articleHtml:
          '<article><h2>Original heading</h2><p>Alpha sentence. <strong>Beta sentence.</strong> Gamma sentence.</p></article>',
        sentences: ['Alpha sentence.', 'Beta sentence.', 'Gamma sentence.'],
      }),
    );

    act(() => {
      container
        .querySelector('.canvas-summary-view__card')
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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
  });

  it('renders neighboring topic sentences while highlighting only the active topic', () => {
    const summaryCardRefs = { current: {} };
    const articleTextRef = React.createRef();
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
      createElement(CanvasSummaryView, {
        summaryViewCards: cards,
        summaryViewActivePath: 'Topic B',
        summaryCardRefs,
        setHoveredTopicKey: vi.fn(),
        articleTextRef,
        onShowSourceSentences: vi.fn(),
        articleHtml: '<p>Alpha sentence. Beta sentence.</p>',
        sentences: ['Alpha sentence.', 'Beta sentence.'],
      }),
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
    const summaryCardRefs = { current: {} };
    const articleTextRef = React.createRef();
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
      createElement(CanvasSummaryView, {
        summaryViewCards: cards,
        summaryViewActivePath: null,
        summaryCardRefs,
        setHoveredTopicKey: vi.fn(),
        articleTextRef,
        onShowSourceSentences: vi.fn(),
        articleHtml:
          '<article><p>Alpha sentence. Beta sentence. Gamma sentence. Delta sentence.</p></article>',
        sentences: ['Alpha sentence.', 'Beta sentence.', 'Gamma sentence.', 'Delta sentence.'],
      }),
    );

    act(() => {
      container
        .querySelectorAll('.canvas-summary-view__card')[1]
        .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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
  });

  it('updates the preview from topic hover even when another summary was clicked', () => {
    const summaryCardRefs = { current: {} };
    const articleTextRef = React.createRef();
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

    const props = {
      summaryViewCards: cards,
      summaryViewActivePath: null,
      summaryViewHoveredPath: null,
      summaryCardRefs,
      setHoveredTopicKey: vi.fn(),
      articleTextRef,
      onShowSourceSentences: vi.fn(),
      articleHtml: '<article><p>Alpha sentence. Beta sentence.</p></article>',
      sentences: ['Alpha sentence.', 'Beta sentence.'],
    };

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
        summaryViewActivePath: 'Topic B',
        summaryViewHoveredPath: 'Topic B',
      }),
    );

    const preview = container.querySelector('.canvas-summary-source-preview');
    expect(preview.textContent).toContain('Beta sentence.');
    const highlights = preview.querySelectorAll('.canvas-summary-source-preview__highlight');
    expect(highlights).toHaveLength(1);
    expect(highlights[0].textContent).toBe('Beta sentence.');

    unmount();
  });
});
