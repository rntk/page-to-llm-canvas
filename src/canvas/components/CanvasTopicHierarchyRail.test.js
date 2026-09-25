// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

const layoutMocks = vi.hoisted(() => ({
  getAdjustedHierarchyCards: vi.fn(),
}));

vi.mock('../../utils/denseCardLayout.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getAdjustedHierarchyCards: (...args) => {
      layoutMocks.getAdjustedHierarchyCards(...args);
      return actual.getAdjustedHierarchyCards(...args);
    },
  };
});

import CanvasTopicHierarchyRail from './CanvasTopicHierarchyRail.jsx';

function render(element, { canvasAncestors = false } = {}) {
  const container = document.createElement('div');
  let rootNode = container;
  if (canvasAncestors) {
    const viewport = document.createElement('div');
    viewport.className = 'canvas-viewport';
    const area = document.createElement('div');
    area.className = 'canvas-area';
    viewport.appendChild(container);
    area.appendChild(viewport);
    rootNode = area;
  }
  document.body.appendChild(rootNode);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      rootNode.remove();
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

  it('returns null without running the card layout when show is false', () => {
    layoutMocks.getAdjustedHierarchyCards.mockClear();
    const { container, rerender, unmount } = render(
      createElement(CanvasTopicHierarchyRail, { ...defaultProps, show: false }),
    );
    expect(container.firstChild).toBeNull();
    expect(layoutMocks.getAdjustedHierarchyCards).not.toHaveBeenCalled();

    rerender(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        show: false,
        topicCards: [...defaultProps.topicCards, { ...defaultProps.topicCards[0], key: 'card3' }],
      }),
    );
    expect(layoutMocks.getAdjustedHierarchyCards).not.toHaveBeenCalled();
    unmount();
  });

  it('restores cards and the current-topic summary after a hide-show cycle', () => {
    const props = {
      ...defaultProps,
      currentTopicSummary: {
        key: 'card2',
        path: 'Topic A > Sub B',
        text: 'A short summary of Sub B.',
      },
    };
    const { container, rerender, unmount } = render(createElement(CanvasTopicHierarchyRail, props));

    expect(container.querySelectorAll('.canvas-topic-hierarchy__card')).toHaveLength(2);
    expect(container.querySelector('.canvas-topic-current-summary')).not.toBeNull();

    rerender(createElement(CanvasTopicHierarchyRail, { ...props, show: false }));
    expect(container.firstChild).toBeNull();

    rerender(createElement(CanvasTopicHierarchyRail, props));
    expect(container.querySelectorAll('.canvas-topic-hierarchy__card')).toHaveLength(2);
    const summary = container.querySelector('.canvas-topic-current-summary');
    expect(summary).not.toBeNull();
    expect(summary.style.getPropertyValue('--current-summary-top')).toBe('80px');
    expect(summary.querySelector('.canvas-summary-view__card-text').textContent).toBe(
      'A short summary of Sub B.',
    );
    unmount();
  });

  it('hides the floating summary outside the canvas bounds and rechecks after pan and resize', () => {
    const resizeObservers = [];
    const mutationObservers = [];
    const rafCallbacks = new Map();
    let nextFrame = 1;
    const originalRaf = window.requestAnimationFrame;
    const originalCancelRaf = window.cancelAnimationFrame;
    const originalResizeObserver = window.ResizeObserver;
    const originalMutationObserver = window.MutationObserver;
    window.requestAnimationFrame = (callback) => {
      const id = nextFrame++;
      rafCallbacks.set(id, callback);
      return id;
    };
    window.cancelAnimationFrame = (id) => rafCallbacks.delete(id);
    window.ResizeObserver = class {
      constructor(callback) {
        this.callback = callback;
        resizeObservers.push(this);
      }
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    };
    window.MutationObserver = class {
      constructor(callback) {
        this.callback = callback;
        this.observe = vi.fn();
        mutationObservers.push(this);
      }
      disconnect() {
        this.disconnected = true;
      }
    };
    let anchorVisible = false;
    const originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains('canvas-area')) return { top: 0, bottom: 100 };
      if (this.classList?.contains('canvas-topic-hierarchy__card')) {
        return anchorVisible ? { top: 20, bottom: 60 } : { top: 120, bottom: 160 };
      }
      return originalRect.call(this);
    };
    const props = {
      ...defaultProps,
      currentTopicSummary: { key: 'card2', path: 'Topic A > Sub B', text: 'Floating summary' },
    };
    const { container, unmount } = render(createElement(CanvasTopicHierarchyRail, props), {
      canvasAncestors: true,
    });

    // Initial measurement should unmount the summary immediately when its card is out of view.
    // The card is measured during mount, so the controllable rects are applied and signaled below.
    resizeObservers[0]?.callback();
    for (const [id, callback] of rafCallbacks) {
      act(() => callback());
      rafCallbacks.delete(id);
    }
    expect(container.querySelector('.canvas-topic-current-summary')).toBeNull();

    anchorVisible = true;
    expect(mutationObservers[0].observe).toHaveBeenCalledWith(
      container.closest('.canvas-viewport'),
      { attributes: true, attributeFilter: ['style', 'class'] },
    );
    act(() => mutationObservers[0].callback());
    for (const [id, callback] of rafCallbacks) {
      act(() => callback());
      rafCallbacks.delete(id);
    }
    expect(container.querySelector('.canvas-topic-current-summary')).not.toBeNull();

    anchorVisible = false;
    act(() => window.dispatchEvent(new Event('resize')));
    for (const [id, callback] of rafCallbacks) {
      act(() => callback());
      rafCallbacks.delete(id);
    }
    expect(container.querySelector('.canvas-topic-current-summary')).toBeNull();

    unmount();
    expect(resizeObservers.every((observer) => observer.disconnected)).toBe(true);
    expect(mutationObservers.every((observer) => observer.disconnected)).toBe(true);
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    window.ResizeObserver = originalResizeObserver;
    window.MutationObserver = originalMutationObserver;
    Element.prototype.getBoundingClientRect = originalRect;
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

    const cards = container.querySelectorAll('.canvas-topic-hierarchy__card');
    expect(cards).toHaveLength(2);

    // card1 (Topic A) is active
    expect(cards[0].className).toContain('is-active');
    expect(cards[0].className).toContain('canvas-topic-hierarchy__card--root');

    // card2 (Topic A > Sub B) is selected
    expect(cards[1].className).toContain('is-selected');
    expect(cards[1].className).toContain('canvas-topic-hierarchy__card--child');

    // hover card2
    const mouseOverEvent = new MouseEvent('mouseover', { bubbles: true });
    act(() => {
      cards[1].dispatchEvent(mouseOverEvent);
    });
    expect(onTopicEnter).toHaveBeenCalledWith({ path: 'Topic A > Sub B', cardKey: 'card2' });

    // leave card2
    const mouseOutEvent = new MouseEvent('mouseout', { bubbles: true });
    act(() => {
      cards[1].dispatchEvent(mouseOutEvent);
    });
    expect(onTopicLeave).toHaveBeenCalledWith({ path: 'Topic A > Sub B', cardKey: 'card2' });

    // click card2
    act(() => {
      cards[1].querySelector('.canvas-topic-hierarchy__card-main').click();
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
    const button = container.querySelector('.canvas-topic-hierarchy__card-main');

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

  it('opens the extensible topic menu and sends the selected card run to its action', async () => {
    const onSelect = vi.fn().mockResolvedValue({ ok: true });
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect }],
      }),
    );

    act(() => {
      container.querySelector('[aria-label="More actions for Topic A > Sub B"]').click();
    });
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(menu.querySelector('[role="menuitem"]').textContent).toBe('Resplit');

    await act(async () => {
      menu.querySelector('[role="menuitem"]').click();
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledWith({
      path: 'Topic A > Sub B',
      startSentence: 6,
      endSentence: 17,
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    unmount();
  });

  it('flips the topic menu above a low trigger and clamps it inside the viewport', () => {
    const originalRect = Element.prototype.getBoundingClientRect;
    const originalHeight = window.innerHeight;
    window.innerHeight = 600;
    Element.prototype.getBoundingClientRect = function () {
      if (this.classList?.contains('canvas-topic-hierarchy__actions-trigger')) {
        return { top: 570, bottom: 590, right: 300, left: 270, width: 30, height: 20 };
      }
      if (this.classList?.contains('canvas-topic-hierarchy__actions-menu')) {
        return { top: 0, bottom: 80, left: 0, right: 176, width: 176, height: 80 };
      }
      return originalRect.call(this);
    };
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect: vi.fn() }],
      }),
    );

    act(() => container.querySelector('[aria-label="More actions for Topic A"]').click());
    const menu = document.body.querySelector('[role="menu"]');
    expect(menu.style.top).toBe('486px');
    expect(menu.style.left).toBe('124px');

    unmount();
    Element.prototype.getBoundingClientRect = originalRect;
    window.innerHeight = originalHeight;
  });

  it('keeps only one topic menu open and toggles it from its trigger', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect: vi.fn() }],
      }),
    );
    const parentTrigger = container.querySelector('[aria-label="More actions for Topic A"]');
    const childTrigger = container.querySelector('[aria-label="More actions for Topic A > Sub B"]');

    act(() => parentTrigger.click());
    expect(document.body.querySelectorAll('[role="menu"]')).toHaveLength(1);

    act(() => {
      childTrigger.dispatchEvent(new Event('pointerdown', { bubbles: true }));
      childTrigger.click();
    });
    const menus = document.body.querySelectorAll('[role="menu"]');
    expect(menus).toHaveLength(1);
    expect(menus[0].getAttribute('aria-label')).toBe('Actions for Topic A > Sub B');

    act(() => childTrigger.click());
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    unmount();
  });

  it('closes the topic menu when the canvas zooms', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect: vi.fn() }],
      }),
    );

    act(() => container.querySelector('[aria-label="More actions for Topic A"]').click());
    expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new Event('wheel', { bubbles: true }));
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    unmount();
  });

  it('ignores repeated selections while an action is in flight', async () => {
    let resolveAction;
    const onSelect = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect }],
      }),
    );

    act(() => container.querySelector('[aria-label="More actions for Topic A"]').click());
    const item = () => document.body.querySelector('[role="menuitem"]');
    await act(async () => {
      item().click();
      await Promise.resolve();
    });
    expect(item().disabled).toBe(true);
    await act(async () => {
      item().click();
      await Promise.resolve();
    });
    expect(onSelect).toHaveBeenCalledOnce();

    await act(async () => {
      resolveAction({ ok: true });
      await Promise.resolve();
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    unmount();
  });

  it('renders topic-specific action titles', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [
          {
            id: 'resplit',
            label: 'Resplit',
            title: ({ path }) => `Resplit ${path}`,
            onSelect: vi.fn(),
          },
        ],
      }),
    );

    act(() => {
      container.querySelector('[aria-label="More actions for Topic A > Sub B"]').click();
    });
    const item = document.body.querySelector('[role="menuitem"]');
    expect(item.disabled).toBe(false);
    expect(item.title).toBe('Resplit Topic A > Sub B');
    unmount();
  });

  it('keeps the menu open and displays stale and failed action responses', async () => {
    const onSelect = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, stale: true })
      .mockResolvedValueOnce({ ok: false, error: 'The topic could not be resplit.' });
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect }],
      }),
    );

    act(() => {
      container.querySelector('[aria-label="More actions for Topic A"]').click();
    });
    let menu = document.body.querySelector('[role="menu"]');
    await act(async () => {
      menu.querySelector('[role="menuitem"]').click();
      await Promise.resolve();
    });
    expect(menu.querySelector('[role="alert"]').textContent).toMatch(/topic changed/i);

    await act(async () => {
      menu.querySelector('[role="menuitem"]').click();
      await Promise.resolve();
    });
    expect(menu.querySelector('[role="alert"]').textContent).toBe(
      'The topic could not be resplit.',
    );
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

  it('scales the current-topic summary card fonts with the canvas zoom', () => {
    const renderAtScale = (scale) => {
      const { container, unmount } = render(
        createElement(CanvasTopicHierarchyRail, {
          ...defaultProps,
          scale,
          topicCards: defaultProps.topicCards.map((card) =>
            card.fullPath === 'Topic A > Sub B'
              ? { ...card, height: 120, titleFontSize: 24 }
              : card,
          ),
          currentTopicSummary: {
            path: 'Topic A > Sub B',
            text: 'A short summary of Sub B.',
          },
        }),
      );
      const summary = container.querySelector('.canvas-topic-current-summary');
      const fonts = {
        kicker: summary.style.getPropertyValue('--current-summary-kicker-font-size'),
        title: summary.style.getPropertyValue('--current-summary-title-font-size'),
        text: summary.style.getPropertyValue('--current-summary-text-font-size'),
      };
      unmount();
      return fonts;
    };

    // At zoom 1 the summary renders at its base sizes, trimmed by the floating
    // panel's 0.85 ratio.
    const atRest = renderAtScale(1);
    expect(Number.parseFloat(atRest.kicker)).toBeCloseTo(11 * 0.85);
    expect(Number.parseFloat(atRest.title)).toBeCloseTo(17.6 * 0.85);
    expect(Number.parseFloat(atRest.text)).toBeCloseTo(15.4 * 0.85);

    // Zoomed out to 0.5 the canvas transform halves everything on screen, so the
    // fonts counter-scale by 1.25 / 0.5 - 0.25 = 2.25 to stay readable.
    const zoomedOut = renderAtScale(0.5);
    expect(Number.parseFloat(zoomedOut.kicker)).toBeCloseTo(11 * 2.25 * 0.85);
    expect(Number.parseFloat(zoomedOut.title)).toBeCloseTo(17.6 * 2.25 * 0.85);
    expect(Number.parseFloat(zoomedOut.text)).toBeCloseTo(15.4 * 2.25 * 0.85);
  });

  it('sizes the summary card the same for a dense and a tall topic-card anchor', () => {
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

    // A short anchor card caps its own title font, but that cap must not reach
    // the floating summary: hovering a small card used to open it at the base
    // 17.6px while the canvas was drawing it at half size (unreadable until a
    // zoom nudge). Both anchors now scale on zoom alone: 1.25 / 0.5 - 0.25.
    const denseFonts = renderForAnchor({ height: 56, titleFontSize: 12 });
    const tallFonts = renderForAnchor({ height: 220, titleFontSize: 40 });

    expect(denseFonts).toEqual(tallFonts);
    expect(Number.parseFloat(denseFonts[1])).toBeCloseTo(17.6 * 2.25 * 0.85);
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

  it('nudges crowded cards apart, compacts them, and stacks the smaller card on top', () => {
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

    const [o1, o2] = container.querySelectorAll('.canvas-topic-hierarchy__card');
    const geometry = (button) => ({
      top: button.style.getPropertyValue('--topic-card-top'),
      height: button.style.getPropertyValue('--topic-card-height'),
      zIndex: button.style.zIndex,
      compact: button.classList.contains('is-compact'),
    });
    // The crowded pair is pushed apart (10px -> 46px gap), shrunk to the compact
    // height, and the card with fewer sentences is stacked above the larger one.
    expect(geometry(o1)).toEqual({ top: '32px', height: '64px', zIndex: '20', compact: true });
    expect(geometry(o2)).toEqual({ top: '78px', height: '64px', zIndex: '27', compact: true });
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
    // link (12.1px base, same as the summary card's) scales to 18.15px instead
    // of staying at a flat size that would shrink into illegibility on the
    // canvas's zoom-out transform.
    expect(card1.style.getPropertyValue('--topic-card-youtube-font-size')).toBe('18.15px');
    unmount();
  });

  it('scales the per-card actions trigger font with the card title font size (zoom)', () => {
    const { container, unmount } = render(
      createElement(CanvasTopicHierarchyRail, {
        ...defaultProps,
        topicCards: defaultProps.topicCards.map((card) =>
          card.key === 'card1' ? { ...card, titleFontSize: 18 } : card,
        ),
        topicActions: [{ id: 'resplit', label: 'Resplit', onSelect: vi.fn() }],
      }),
    );

    const cards = Array.from(container.querySelectorAll('.canvas-topic-hierarchy__card'));
    const card1 = cards.find((el) => el.textContent.includes('A'));
    const card2 = cards.find((el) => el.textContent.includes('B'));
    // titleFontSize 18 vs. the 12px base is a 1.5x zoom multiplier, so the
    // trigger (16px base) scales to 24px instead of staying a flat size that
    // would shrink with the canvas zoom-out transform into an untappable dot.
    expect(card1.style.getPropertyValue('--topic-card-actions-font-size')).toBe('24px');
    // The base-size card keeps the 16px base (multiplier clamped to 1).
    expect(card2.style.getPropertyValue('--topic-card-actions-font-size')).toBe('16px');
    unmount();
  });

  it('keeps the per-card actions trigger pinned to the visible slice of tall cards', () => {
    // The canvas pans via a CSS transform, so the sticky title tracks the
    // visible slice with a translateY offset instead of position: sticky. The
    // actions trigger uses the same technique: without it the button sits at
    // the card top and scrolls out of reach on tall cards.
    const css = readFileSync('src/canvas/modal.css', 'utf8');
    const triggerBlock = css.match(/\.canvas-topic-hierarchy__actions-trigger\s*\{[^}]*\}/)?.[0];
    expect(triggerBlock).toBeTruthy();
    for (const token of [
      '--canvas-translate-y',
      '--canvas-scale',
      '--canvas-area-height',
      '--topic-card-top',
      '--topic-card-height',
      'translateY',
    ]) {
      expect(triggerBlock).toContain(token);
    }
    // Clamped so the trigger never leaves its card, and gliding with the
    // title while panning or focusing instead of jumping.
    expect(triggerBlock).toMatch(/clamp\(/);
    expect(css).toMatch(
      /\.canvas-area\.is-pan-smoothing\s+\.canvas-topic-hierarchy__actions-trigger\s*\{[^}]*transform/,
    );
    expect(css).toMatch(
      /\.canvas-viewport\.is-focusing-highlight\s+\.canvas-topic-hierarchy__actions-trigger\s*\{[^}]*transform/,
    );
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

  it('staggers the card entrance within a capped window while revealing', () => {
    const { container, rerender, unmount } = render(
      createElement(CanvasTopicHierarchyRail, { ...defaultProps, isEntering: true }),
    );

    const body = container.querySelector('.canvas-topic-hierarchy__body');
    expect(body.className).toContain('is-entering');
    const delays = [...container.querySelectorAll('.canvas-topic-hierarchy__card')].map((card) =>
      Number.parseInt(card.style.getPropertyValue('--topic-card-enter-delay') || '0', 10),
    );
    expect(delays[0]).toBe(0);
    expect(delays[delays.length - 1]).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(240);

    // Once the entrance is over the class goes away and no card keeps a delay.
    rerender(createElement(CanvasTopicHierarchyRail, { ...defaultProps, isEntering: false }));
    expect(container.querySelector('.canvas-topic-hierarchy__body').className).not.toContain(
      'is-entering',
    );
    unmount();
  });

  it('glides a same-layout remeasure but not a level switch', () => {
    vi.useFakeTimers();
    const props = { ...defaultProps, layoutKey: 'article:1' };
    const { container, rerender, unmount } = render(createElement(CanvasTopicHierarchyRail, props));
    const body = () => container.querySelector('.canvas-topic-hierarchy__body');
    expect(body().className).not.toContain('is-settling');

    // A late image reflowing the article moves the cards under the same layout:
    // glide them.
    const movedCards = props.topicCards.map((card) => ({ ...card, top: card.top + 40 }));
    rerender(createElement(CanvasTopicHierarchyRail, { ...props, topicCards: movedCards }));
    expect(body().className).toContain('is-settling');
    act(() => vi.advanceTimersByTime(400));
    expect(body().className).not.toContain('is-settling');

    // A level switch swaps the card set deliberately and the canvas alignment
    // pass already animates it — no competing per-card transition.
    const nextLevelCards = movedCards.map((card) => ({ ...card, top: card.top + 100 }));
    rerender(
      createElement(CanvasTopicHierarchyRail, {
        ...props,
        topicCards: nextLevelCards,
        layoutKey: 'article:0',
      }),
    );
    expect(body().className).not.toContain('is-settling');
    unmount();
    vi.useRealTimers();
  });

  it('drops the glide when a layout switch interrupts it mid-flight', () => {
    vi.useFakeTimers();
    const props = { ...defaultProps, layoutKey: 'article:1' };
    const { container, rerender, unmount } = render(createElement(CanvasTopicHierarchyRail, props));
    const body = () => container.querySelector('.canvas-topic-hierarchy__body');

    const movedCards = props.topicCards.map((card) => ({ ...card, top: card.top + 40 }));
    rerender(createElement(CanvasTopicHierarchyRail, { ...props, topicCards: movedCards }));
    expect(body().className).toContain('is-settling');

    // A level switch part-way through the glide cancels the timer that would
    // have cleared the flag; if it latched here, every later geometry change
    // would animate forever.
    act(() => vi.advanceTimersByTime(100));
    const switchedCards = movedCards.map((card) => ({ ...card, top: card.top + 100 }));
    rerender(
      createElement(CanvasTopicHierarchyRail, {
        ...props,
        topicCards: switchedCards,
        layoutKey: 'article:0',
      }),
    );
    expect(body().className).not.toContain('is-settling');
    act(() => vi.advanceTimersByTime(400));
    expect(body().className).not.toContain('is-settling');

    unmount();
    vi.useRealTimers();
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
