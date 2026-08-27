// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import InPageRail from './InPageRail.jsx';

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

describe('InPageRail', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb) => cb());
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const mockCards = [
    {
      id: 'card1',
      name: 'Card 1',
      path: 'Topic A',
      accent: 'red',
      box: { top: 100, height: 200 },
      sentences: [1, 2],
    },
    {
      id: 'card2',
      name: 'Card 2',
      path: 'Topic B',
      accent: 'blue',
      box: { top: 350, height: 150 },
      sentences: [3, 4],
    },
  ];

  const defaultProps = {
    mode: 'topics',
    maxLevel: 2,
    selectedLevel: 1,
    cards: mockCards,
    bodyHeight: 800,
    onClose: vi.fn(),
    onSelectMode: vi.fn(),
    onSelectLevel: vi.fn(),
    onHighlightCard: vi.fn(),
    onScrollToCard: vi.fn(),
    scrollContainer: null,
  };

  it('renders topics mode layout, close button and switcher', () => {
    const onClose = vi.fn();
    const onSelectLevel = vi.fn();
    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, onClose, onSelectLevel }),
    );

    // Close button click
    const closeBtn = container.querySelector('.pagetollm-rail-close');
    expect(closeBtn).not.toBeNull();
    act(() => closeBtn.click());
    expect(onClose).toHaveBeenCalled();

    // Level buttons rendering & click
    const lvlButtons = container.querySelectorAll('.pagetollm-rail-level-btn');
    expect(lvlButtons).toHaveLength(3); // L0, L1, L2
    expect(lvlButtons[1].className).toContain('active');
    act(() => lvlButtons[2].click());
    expect(onSelectLevel).toHaveBeenCalledWith(2);

    unmount();
  });

  it('shows parent topics as a muted part of nested card titles', () => {
    const nestedCard = {
      ...mockCards[1],
      name: 'Child topic',
      path: 'Parent topic > Child topic',
    };
    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, cards: [nestedCard] }),
    );

    const title = container.querySelector('.pagetollm-rail-card-title');
    expect(title.textContent).toBe('Parent topicChild topic');
    expect(title.querySelector('.pagetollm-rail-card-parent-topics').textContent).toBe(
      'Parent topic',
    );
    expect(title.querySelector('.pagetollm-rail-card-current-topic').textContent).toBe(
      'Child topic',
    );

    unmount();
  });

  it('handles native mode switching', () => {
    const onSelectMode = vi.fn();
    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, onSelectMode }),
    );

    const select = container.querySelector('.pagetollm-rail-mode-select');
    expect(select).not.toBeNull();
    expect(select.value).toBe('topics');
    expect(select.querySelectorAll('option')).toHaveLength(5);

    act(() => {
      select.value = 'summaries';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelectMode).toHaveBeenCalledWith('summaries');

    unmount();
  });

  it('places chat History and New controls in the rail header', () => {
    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, mode: 'chat', recordKey: 'record-1' }),
    );

    const railHead = container.querySelector('.pagetollm-rail-head');
    expect(railHead.querySelector('.pagetollm-chat-actions')).not.toBeNull();
    expect(railHead.textContent).toContain('History');
    expect(railHead.textContent).toContain('New');
    expect(container.querySelector('.pagetollm-chat-header')).toBeNull();

    unmount();
  });

  it('renders RailCards and registers pointer, click, hover events in topics mode', () => {
    const onHighlightCard = vi.fn();
    const onScrollToCard = vi.fn();

    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, onHighlightCard, onScrollToCard }),
    );

    const cards = container.querySelectorAll('.pagetollm-rail-card');
    expect(cards).toHaveLength(2);

    // Mouse enter Card 1
    act(() => {
      cards[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(onHighlightCard).toHaveBeenCalledWith(mockCards[0], true);

    // Mouse leave Card 1
    onHighlightCard.mockClear();
    act(() => {
      cards[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });
    expect(onHighlightCard).toHaveBeenCalledWith(mockCards[0], false);

    // Pointer down Card 2
    act(() => {
      cards[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(cards[1].className).toContain('is-front');

    // Click Card 2
    act(() => {
      cards[1].click();
    });
    expect(onScrollToCard).toHaveBeenCalledWith(mockCards[1]);

    unmount();
  });

  it('offsets topic titles for nested scroll containers', () => {
    const mockScrollContainer = document.createElement('div');
    let scrollTop = 120;
    Object.defineProperty(mockScrollContainer, 'scrollTop', {
      get: () => scrollTop,
      configurable: true,
    });

    const { container, rerender, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        scrollContainer: mockScrollContainer,
      }),
    );

    const railBody = container.querySelector('.pagetollm-rail-body');
    const firstCard = container.querySelector('.pagetollm-rail-card');

    expect(railBody.style.transform).toBe('translateY(-120px)');
    expect(railBody.className).toContain('is-nested-scroll');
    expect(railBody.style.getPropertyValue('--pagetollm-scroll-offset')).toBe('120px');
    expect(firstCard.className).toContain('is-topic');
    expect(firstCard.style.getPropertyValue('--pagetollm-card-top')).toBe('100px');
    expect(firstCard.style.getPropertyValue('--pagetollm-card-height')).toBe('200px');

    scrollTop = 240;
    act(() => mockScrollContainer.dispatchEvent(new Event('scroll')));
    expect(railBody.style.transform).toBe('translateY(-240px)');
    expect(railBody.style.getPropertyValue('--pagetollm-scroll-offset')).toBe('240px');

    rerender(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        scrollContainer: mockScrollContainer,
      }),
    );
    expect(railBody.style.transform).toBe('');

    unmount();
  });

  it('handles SummaryCursorView logic in summaries mode', async () => {
    const onHighlightCard = vi.fn();
    const onScrollToCard = vi.fn();
    const rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });

    const flushFrames = () => {
      while (rafCallbacks.length) {
        rafCallbacks.shift()();
      }
    };

    const mockScrollContainer = document.createElement('div');
    mockScrollContainer.getBoundingClientRect = () => ({
      top: 100,
      bottom: 900,
      left: 0,
      right: 0,
      height: 800,
      width: 200,
    });
    Object.defineProperty(mockScrollContainer, 'clientHeight', { value: 800, configurable: true });
    let scrollTop = 0;
    Object.defineProperty(mockScrollContainer, 'scrollTop', {
      get: () => scrollTop,
      configurable: true,
    });

    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        onHighlightCard,
        onScrollToCard,
        scrollContainer: mockScrollContainer,
      }),
    );

    const railBody = container.querySelector('.pagetollm-rail-body');
    railBody.getBoundingClientRect = () => ({
      top: 150,
      bottom: 950,
      left: 0,
      right: 0,
      height: 800,
      width: 200,
    });

    onHighlightCard.mockClear();
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    await Promise.resolve();
    expect(onHighlightCard).toHaveBeenCalledWith(mockCards[0], true);

    onHighlightCard.mockClear();
    scrollTop = 100;
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    await Promise.resolve();
    expect(onHighlightCard).toHaveBeenCalledWith(mockCards[0], false);
    expect(onHighlightCard).toHaveBeenCalledWith(mockCards[1], true);

    const activeLine = container.querySelector('.pagetollm-summary-cursor-line');
    expect(activeLine).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    unmount();
  });

  it('lists the surrounding topics as titles around the active summary', async () => {
    const onHighlightCard = vi.fn();
    const onScrollToCard = vi.fn();
    const rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const flushFrames = () => {
      while (rafCallbacks.length) rafCallbacks.shift()();
    };

    const cards = [
      ...mockCards,
      {
        id: 'card3',
        name: 'Card 3',
        path: 'Topic C',
        accent: 'green',
        box: { top: 550, height: 150 },
        sentences: [5, 6],
      },
    ];

    const mockScrollContainer = document.createElement('div');
    mockScrollContainer.getBoundingClientRect = () => ({ top: 100, height: 800 });
    Object.defineProperty(mockScrollContainer, 'clientHeight', { value: 800, configurable: true });
    Object.defineProperty(mockScrollContainer, 'scrollTop', { value: 100, configurable: true });

    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        cards,
        onHighlightCard,
        onScrollToCard,
        scrollContainer: mockScrollContainer,
      }),
    );

    container.querySelector('.pagetollm-rail-body').getBoundingClientRect = () => ({
      top: 150,
      height: 800,
    });
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    await Promise.resolve();

    // Cursor resolves to card2, so card1 sits above it and card3 below.
    expect(container.querySelector('.pagetollm-summary-active-card-title').textContent).toContain(
      'Card 2',
    );
    const before = container.querySelectorAll('.is-before .pagetollm-summary-topic');
    const after = container.querySelectorAll('.is-after .pagetollm-summary-topic');
    expect(before).toHaveLength(1);
    expect(before[0].textContent).toContain('Card 1');
    expect(after).toHaveLength(1);
    expect(after[0].textContent).toContain('Card 3');

    onHighlightCard.mockClear();
    act(() => {
      after[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      after[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
    });
    expect(onHighlightCard).toHaveBeenCalledWith(cards[2], true);

    act(() => {
      after[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      after[0].dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    });
    expect(onHighlightCard).toHaveBeenCalledWith(cards[2], false);

    act(() => {
      after[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onScrollToCard).toHaveBeenCalledWith(cards[2]);

    unmount();
  });

  it('reverses the enter direction when the cursor moves back up the article', () => {
    const rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const flushFrames = () => {
      while (rafCallbacks.length) rafCallbacks.shift()();
    };

    const mockScrollContainer = document.createElement('div');
    mockScrollContainer.getBoundingClientRect = () => ({ top: 100, height: 800 });
    Object.defineProperty(mockScrollContainer, 'clientHeight', { value: 800, configurable: true });
    let scrollTop = 100;
    Object.defineProperty(mockScrollContainer, 'scrollTop', {
      get: () => scrollTop,
      configurable: true,
    });

    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        scrollContainer: mockScrollContainer,
      }),
    );

    container.querySelector('.pagetollm-rail-body').getBoundingClientRect = () => ({
      top: 150,
      height: 800,
    });
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    // Mounting already resolves card2, so this only pins the default direction;
    // the upward transition below is the assertion that exercises the logic.
    expect(container.querySelector('.pagetollm-summary-active-card').className).toContain(
      'is-enter-down',
    );

    scrollTop = 0;
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    // relativeY 254 → back to card1, arriving from above.
    expect(container.querySelector('.pagetollm-summary-active-card').className).toContain(
      'is-enter-up',
    );

    unmount();
  });

  it('splits the topics around the cursor when it falls between summaries', async () => {
    const rafCallbacks = [];
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    const flushFrames = () => {
      while (rafCallbacks.length) rafCallbacks.shift()();
    };

    const cards = [
      ...mockCards,
      {
        id: 'card3',
        name: 'Card 3',
        path: 'Topic C',
        accent: 'green',
        box: { top: 550, height: 150 },
        sentences: [5, 6],
      },
    ];

    const mockScrollContainer = document.createElement('div');
    mockScrollContainer.getBoundingClientRect = () => ({ top: 100, height: 800 });
    Object.defineProperty(mockScrollContainer, 'clientHeight', { value: 800, configurable: true });
    // Cursor lands at 320 in card space: past card1 (100-300), before card2 (350-500).
    Object.defineProperty(mockScrollContainer, 'scrollTop', { value: 66, configurable: true });

    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        cards,
        scrollContainer: mockScrollContainer,
      }),
    );

    container.querySelector('.pagetollm-rail-body').getBoundingClientRect = () => ({
      top: 150,
      height: 800,
    });
    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
      flushFrames();
    });
    await Promise.resolve();

    // The summary sticks to the last card above the cursor instead of blanking.
    expect(container.querySelector('.pagetollm-summary-active-card-title').textContent).toContain(
      'Card 1',
    );
    expect(container.querySelectorAll('.is-before .pagetollm-summary-topic')).toHaveLength(0);
    expect(container.querySelectorAll('.is-after .pagetollm-summary-topic')).toHaveLength(2);

    unmount();
  });

  it('shows a notice instead of an empty summary rail when summaries are disabled', () => {
    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        mode: 'summaries',
        cards: [],
        summariesDisabled: true,
      }),
    );

    const notice = container.querySelector('.pagetollm-rail-empty');
    expect(notice).not.toBeNull();
    expect(notice.textContent).toContain('Summaries are disabled');
    expect(container.querySelector('.pagetollm-summary-cursor-line')).toBeNull();

    unmount();
  });

  it('does not show the disabled notice in topics mode even if summariesDisabled is true', () => {
    const { container, unmount } = render(
      createElement(InPageRail, {
        ...defaultProps,
        summariesDisabled: true,
      }),
    );

    expect(container.querySelector('.pagetollm-rail-empty')).toBeNull();
    expect(container.querySelectorAll('.pagetollm-rail-card')).toHaveLength(2);

    unmount();
  });
});
