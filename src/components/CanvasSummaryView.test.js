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
});
