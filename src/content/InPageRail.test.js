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
      sentences: [0, 1],
    },
    {
      id: 'card2',
      name: 'Card 2',
      path: 'Topic B',
      accent: 'blue',
      box: { top: 350, height: 150 },
      sentences: [2, 3],
    },
  ];

  const defaultProps = {
    recordKey: 'testKey',
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

  it('handles dropdown mode switching and keyboard navigation', () => {
    const onSelectMode = vi.fn();
    const { container, unmount } = render(
      createElement(InPageRail, { ...defaultProps, onSelectMode }),
    );

    const toggleBtn = container.querySelector('.pagetollm-rail-dropdown-toggle');
    const containerDiv = container.querySelector('.pagetollm-rail-dropdown-container');

    expect(containerDiv.className).not.toContain('open');

    // Click to open
    act(() => toggleBtn.click());
    expect(containerDiv.className).toContain('open');

    // Click document to close dropdown
    act(() => {
      document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(containerDiv.className).not.toContain('open');

    // Keyboard navigation: Escape
    act(() => toggleBtn.click()); // open it again
    expect(containerDiv.className).toContain('open');
    act(() => {
      containerDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(containerDiv.className).not.toContain('open');

    // Keyboard navigation: ArrowDown
    act(() => {
      containerDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(containerDiv.className).toContain('open');

    // ArrowUp, Home, End keyboard events
    act(() => {
      containerDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
      containerDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      containerDiv.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });

    // Choose mode
    const items = container.querySelectorAll('.pagetollm-rail-dropdown-item');
    expect(items).toHaveLength(4);
    act(() => items[1].click()); // Click summaries
    expect(onSelectMode).toHaveBeenCalledWith('summaries');

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

  it('handles SummaryCursorView logic in summaries mode', () => {
    const onHighlightCard = vi.fn();
    const onScrollToCard = vi.fn();

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
    Object.defineProperty(mockScrollContainer, 'scrollTop', { value: 50, configurable: true });

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

    act(() => {
      mockScrollContainer.dispatchEvent(new Event('scroll'));
    });

    const activeLine = container.querySelector('.pagetollm-summary-cursor-line');
    expect(activeLine).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    unmount();
  });
});
