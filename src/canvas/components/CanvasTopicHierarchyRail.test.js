// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CanvasTopicHierarchyRail from './CanvasTopicHierarchyRail.jsx';

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

describe('CanvasTopicHierarchyRail', () => {
  const defaultProps = {
    show: true,
    selectedLevel: 1,
    topicCards: [
      {
        key: 'card1',
        fullPath: 'Topic A',
        displayName: 'A',
        sentenceCount: 5,
        startSentence: 1,
        endSentence: 5,
        top: 10,
        height: 60,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      },
      {
        key: 'card2',
        fullPath: 'Topic A > Sub B',
        displayName: 'B',
        sentenceCount: 12,
        startSentence: 6,
        endSentence: 17,
        top: 80,
        height: 70,
        titleFontSize: 12,
        depth: 1,
        levelIndex: 1,
        right: 10,
      },
    ],
    railWidth: 200,
    cardWidth: 180,
    activeTopic: null,
    selectedTopic: null,
    onTopicEnter: vi.fn(),
    onTopicLeave: vi.fn(),
    onTopicClick: vi.fn(),
  };

  it('returns null when show is false', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, { ...defaultProps, show: false }),
    );
    expect(container.firstChild).toBeNull();
    unmount();
  });

  it('renders empty state when there are no cards at or below selectedLevel', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        selectedLevel: 0,
        topicCards: [],
      }),
    );
    const emptyMsg = container.querySelector('.canvas-topic-hierarchy__empty');
    expect(emptyMsg).not.toBeNull();
    expect(emptyMsg.textContent).toContain('No topics at this level');
    unmount();
  });

  it('handles non-array or null topicCards gracefully', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: null,
      }),
    );
    const emptyMsg = container.querySelector('.canvas-topic-hierarchy__empty');
    expect(emptyMsg).not.toBeNull();
    unmount();
  });

  it('renders cards and handles hover and click', () => {
    const onTopicEnter = vi.fn();
    const onTopicLeave = vi.fn();
    const onTopicClick = vi.fn();

    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        activeTopic: { path: 'Topic A', cardKey: 'card1' },
        selectedTopic: { path: 'Topic A > Sub B', cardKey: 'card2' },
        onTopicEnter,
        onTopicLeave,
        onTopicClick,
      }),
    );

    const buttons = container.querySelectorAll('.canvas-topic-hierarchy__card');
    expect(buttons).toHaveLength(2);

    // card1 (Topic A) is active
    expect(buttons[0].className).toContain('is-active');
    expect(buttons[0].className).toContain('canvas-topic-hierarchy__card--root');

    // card2 (Topic A > Sub B) is selected
    expect(buttons[1].className).toContain('is-selected');
    expect(buttons[1].className).toContain('canvas-topic-hierarchy__card--child');

    // hover card2
    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true });
    act(() => {
      buttons[1].dispatchEvent(mouseOverEvent);
    });
    expect(onTopicEnter).toHaveBeenCalledWith({ path: 'Topic A > Sub B', cardKey: 'card2' });

    // leave card2
    const mouseOutEvent = new MouseEvent('mouseout', { bubbles: true });
    act(() => {
      buttons[1].dispatchEvent(mouseOutEvent);
    });
    expect(onTopicLeave).toHaveBeenCalledWith({ path: 'Topic A > Sub B', cardKey: 'card2' });

    // click card2
    act(() => {
      buttons[1].click();
    });
    expect(onTopicClick).toHaveBeenCalledWith(
      { path: 'Topic A > Sub B', cardKey: 'card2' },
      expect.objectContaining({ key: 'card2' }),
    );
    unmount();
  });

  it('uses card keys for active and selected styling when duplicate path cards exist', () => {
    const duplicatePathCards = [
      {
        ...defaultProps.topicCards[1],
        key: 'sub-b-run-1',
        top: 80,
        startSentence: 6,
        endSentence: 8,
      },
      {
        ...defaultProps.topicCards[1],
        key: 'sub-b-run-2',
        top: 180,
        startSentence: 15,
        endSentence: 17,
      },
    ];

    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: duplicatePathCards,
        activeTopic: { path: 'Topic A > Sub B', cardKey: 'sub-b-run-2' },
        selectedTopic: { path: 'Topic A > Sub B', cardKey: 'sub-b-run-2' },
      }),
    );

    const buttons = container.querySelectorAll('.canvas-topic-hierarchy__card');
    expect(buttons[0].className).not.toContain('is-active');
    expect(buttons[0].className).not.toContain('is-selected');
    expect(buttons[1].className).toContain('is-active');
    expect(buttons[1].className).toContain('is-selected');
    unmount();
  });

  it('handles onMouseDown propagation based on target', () => {
    const { container, unmount } = render(createElement(CanvasTopicHierarchyRail, defaultProps));

    const aside = container.querySelector('.canvas-topic-hierarchy');
    const button = container.querySelector('.canvas-topic-hierarchy__card');

    // Click on button inside aside
    const mousedownOnBtn = new MouseEvent('mousedown', { bubbles: true });
    vi.spyOn(mousedownOnBtn, 'stopPropagation');
    act(() => {
      button.dispatchEvent(mousedownOnBtn);
    });
    expect(mousedownOnBtn.stopPropagation).toHaveBeenCalled();

    // Click on aside itself
    const mousedownOnAside = new MouseEvent('mousedown', { bubbles: true });
    vi.spyOn(mousedownOnAside, 'stopPropagation');
    act(() => {
      aside.dispatchEvent(mousedownOnAside);
    });
    expect(mousedownOnAside.stopPropagation).not.toHaveBeenCalled();

    unmount();
  });

  it('renders the current-topic summary card aligned to its rail card', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        currentTopicSummary: {
          path: 'Topic A > Sub B',
          text: 'A short summary of Sub B.',
        },
      }),
    );

    const summary = container.querySelector('.canvas-topic-current-summary');
    expect(summary).not.toBeNull();
    // Vertically aligned with card2 (top: 80).
    expect(summary.style.getPropertyValue('--current-summary-top')).toBe('80px');
    expect(summary.querySelector('.canvas-summary-view__card-kicker').textContent).toBe('Summary');
    expect(summary.querySelector('.canvas-summary-view__card-path').textContent).toBe(
      'Topic A > Sub B',
    );
    expect(summary.querySelector('.canvas-summary-view__card-text').textContent).toBe(
      'A short summary of Sub B.',
    );
    expect(summary.querySelector('.canvas-summary-view__card-meta')).toBeNull();
    unmount();
  });

  it('aligns the current-topic summary to the matching repeated topic card key', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: [
          {
            ...defaultProps.topicCards[0],
            key: 'Technology#0#0',
            fullPath: 'Technology',
            displayName: 'Technology',
            startSentence: 1,
            endSentence: 2,
            top: 20,
          },
          {
            ...defaultProps.topicCards[0],
            key: 'Technology#0#1',
            fullPath: 'Technology',
            displayName: 'Technology',
            startSentence: 20,
            endSentence: 21,
            top: 140,
          },
        ],
        currentTopicSummary: {
          key: 'Technology#0#1',
          path: 'Technology',
          text: 'Second technology occurrence.',
        },
      }),
    );

    const summary = container.querySelector('.canvas-topic-current-summary');
    expect(summary).not.toBeNull();
    expect(summary.style.getPropertyValue('--current-summary-top')).toBe('140px');
    expect(summary.querySelector('.canvas-summary-view__card-text').textContent).toBe(
      'Second technology occurrence.',
    );
    unmount();
  });

  it('scales the current-topic summary card fonts with its topic-card title', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: defaultProps.topicCards.map((card) =>
          card.fullPath === 'Topic A > Sub B' ? { ...card, height: 120, titleFontSize: 24 } : card,
        ),
        currentTopicSummary: {
          path: 'Topic A > Sub B',
          text: 'A short summary of Sub B.',
        },
      }),
    );

    // The topic title is 2x the 12px base, so every summary metric is 2x too.
    const summary = container.querySelector('.canvas-topic-current-summary');
    expect(summary.style.getPropertyValue('--current-summary-kicker-font-size')).toBe('20px');
    expect(summary.style.getPropertyValue('--current-summary-title-font-size')).toBe('32px');
    expect(summary.style.getPropertyValue('--current-summary-text-font-size')).toBe('28px');
    unmount();
  });

  it('keeps the summary card capped with a dense topic-card title', () => {
    const renderForAnchor = (anchorOverrides) => {
      const { container, unmount } = render(
        createElement(CanvasTopicHierarchyRail, {
          ...defaultProps,
          scale: 0.5,
          topicCards: defaultProps.topicCards.map((card) =>
            card.fullPath === 'Topic A > Sub B' ? { ...card, ...anchorOverrides } : card,
          ),
          currentTopicSummary: {
            path: 'Topic A > Sub B',
            text: 'A short summary of Sub B.',
          },
        }),
      );
      const summary = container.querySelector('.canvas-topic-current-summary');
      const fonts = [
        summary.style.getPropertyValue('--current-summary-kicker-font-size'),
        summary.style.getPropertyValue('--current-summary-title-font-size'),
        summary.style.getPropertyValue('--current-summary-text-font-size'),
      ];
      unmount();
      return fonts;
    };

    const denseFonts = renderForAnchor({ height: 56, titleFontSize: 20 });
    const tallFonts = renderForAnchor({ height: 220, titleFontSize: 40 });

    expect(Number.parseFloat(denseFonts[1])).toBeCloseTo(16 * (20 / 12));
    expect(Number.parseFloat(tallFonts[1])).toBeCloseTo(16 * (40 / 12));
    expect(Number.parseFloat(denseFonts[1])).toBeLessThan(Number.parseFloat(tallFonts[1]));
  });

  it('renders compact cards with one larger title line and matching label height', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: [
          {
            ...defaultProps.topicCards[0],
            height: 56,
            titleFontSize: 20,
          },
        ],
      }),
    );

    const button = container.querySelector('.canvas-topic-hierarchy__card');
    expect(button.className).toContain('is-compact');
    expect(button.style.getPropertyValue('--topic-card-title-line-clamp')).toBe('1');
    expect(button.style.getPropertyValue('--topic-card-label-height')).toBe('39px');
    expect(button.style.getPropertyValue('--topic-card-title-font-size')).toBe('20px');
    unmount();
  });

  it('omits the current-topic summary card when none is provided', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        currentTopicSummary: null,
      }),
    );
    expect(container.querySelector('.canvas-topic-current-summary')).toBeNull();
    unmount();
  });

  it('cancels the current topic selection on Escape', () => {
    const onCancelTopicSelection = vi.fn();
    const { unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        selectedTopic: { path: 'Topic A > Sub B', cardKey: 'card2' },
        currentTopicSummary: {
          path: 'Topic A > Sub B',
          text: 'A short summary of Sub B.',
        },
        onCancelTopicSelection,
      }),
    );

    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    vi.spyOn(event, 'preventDefault');
    act(() => {
      window.dispatchEvent(event);
    });

    expect(event.preventDefault).toHaveBeenCalled();
    expect(onCancelTopicSelection).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('handles crowding and overlap logic (nudgeCrowdedPair & compact height)', () => {
    // Create two cards that overlap significantly
    const overlappingCards = [
      {
        key: 'o1',
        fullPath: 'Over 1',
        displayName: 'O1',
        sentenceCount: 15,
        startSentence: 1,
        endSentence: 10,
        top: 50,
        height: 80,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      },
      {
        key: 'o2',
        fullPath: 'Over 2',
        displayName: 'O2',
        sentenceCount: 3,
        startSentence: 11,
        endSentence: 15,
        top: 60,
        height: 80,
        titleFontSize: 12,
        depth: 0,
        levelIndex: 0,
        right: 0,
      },
    ];

    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: overlappingCards,
      }),
    );

    const buttons = container.querySelectorAll('.canvas-topic-hierarchy__card');
    expect(buttons).toHaveLength(2);
    unmount();
  });

  it('caps font size based on fixed rendered spacing', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: [
          {
            key: 'o1',
            fullPath: 'Topic A',
            displayName: 'Topic A',
            sentenceCount: 5,
            startSentence: 1,
            endSentence: 5,
            top: 50,
            height: 72,
            titleFontSize: 40,
            depth: 0,
            levelIndex: 0,
            right: 0,
          },
        ],
      }),
    );

    const button = container.querySelector('.canvas-topic-hierarchy__card');
    // At local height=72, with fixed spacing:
    // availableTitleHeight = 72 - 31 = 41px.
    // heightCapped = 41 / 1.2 = 34.16px.
    // Since titleFontSize is 40, it exceeds heightCapped and should be capped to ~34px.
    expect(button.style.getPropertyValue('--topic-card-title-font-size')).toContain('34');
    unmount();
  });

  it('renders a YouTube timestamp link on the summary card for YouTube records', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        currentTopicSummary: {
          path: 'Topic A',
          text: 'A summary.',
          sourceSentences: [4],
        },
        sentences: ['a', 'b', 'c', '0:26 26 seconds Blackwell is a card.'],
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
      }),
    );

    const link = container.querySelector('a.canvas-youtube-timestamp');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('v=abc');
    expect(link.getAttribute('href')).toContain('&t=26s');
    expect(link.textContent).toContain('0:26');
    unmount();
  });

  it('does not render a YouTube link for non-YouTube records', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        currentTopicSummary: {
          path: 'Topic A',
          text: 'A summary.',
          sourceSentences: [4],
        },
        sentences: ['a', 'b', 'c', '0:26 26 seconds Blackwell is a card.'],
        sourceUrl: 'https://example.com/post',
      }),
    );

    expect(container.querySelector('a.canvas-youtube-timestamp')).toBeNull();
    unmount();
  });

  it('renders a per-card YouTube timestamp link next to the sentence count on YouTube records', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        sentences: ['0:05 5 seconds Intro.', 'b', 'c', 'd'],
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
      }),
    );

    const card1 = Array.from(container.querySelectorAll('.canvas-topic-hierarchy__card')).find(
      (el) => el.textContent.includes('A'),
    );
    const link = card1.querySelector('a.canvas-youtube-timestamp');
    expect(link).not.toBeNull();
    expect(link.getAttribute('href')).toContain('v=abc');
    expect(link.getAttribute('href')).toContain('&t=5s');
    // Lives in the meta row, next to the sentence count text.
    expect(link.closest('.canvas-topic-hierarchy__card-meta-row').textContent).toContain('5 sent.');
    unmount();
  });

  it('scales the per-card YouTube link font with the card title font size (zoom)', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: defaultProps.topicCards.map((card) =>
          card.key === 'card1' ? { ...card, titleFontSize: 18 } : card,
        ),
        sentences: ['0:05 5 seconds Intro.', 'b', 'c', 'd'],
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
      }),
    );

    const card1 = Array.from(container.querySelectorAll('.canvas-topic-hierarchy__card')).find(
      (el) => el.textContent.includes('A'),
    );
    // titleFontSize 18 vs. the 12px base is a 1.5x zoom multiplier, so the
    // link (11px base, same as the summary card's) scales to 16.5px instead
    // of staying at a flat size that would shrink into illegibility on the
    // canvas's zoom-out transform.
    expect(card1.style.getPropertyValue('--topic-card-youtube-font-size')).toBe('16.5px');
    unmount();
  });

  it('does not render a per-card YouTube link for non-YouTube records', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        sentences: ['0:05 5 seconds Intro.', 'b', 'c', 'd'],
        sourceUrl: 'https://example.com/post',
      }),
    );

    expect(container.querySelector('a.canvas-youtube-timestamp')).toBeNull();
    unmount();
  });

  it('clicking the per-card YouTube link does not trigger the card click', () => {
    const onTopicClick = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        onTopicClick,
        sentences: ['0:05 5 seconds Intro.', 'b', 'c', 'd'],
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
      }),
    );

    const link = container.querySelector('a.canvas-youtube-timestamp');
    act(() => {
      link.click();
    });

    expect(onTopicClick).not.toHaveBeenCalled();
    unmount();
  });
});
