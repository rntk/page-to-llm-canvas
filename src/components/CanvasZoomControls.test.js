// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CanvasZoomControls from './CanvasZoomControls.jsx';

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

describe('CanvasZoomControls', () => {
  const defaultProps = {
    onNavigate: vi.fn(),
    onZoomIn: vi.fn(),
    onZoomOut: vi.fn(),
    onReset: vi.fn(),
    showSummaryMode: false,
    onToggleSummaryMode: vi.fn(),
    showTopicHierarchy: false,
    onToggleTopicHierarchy: vi.fn(),
    onClose: vi.fn(),
    selectedLevel: 1,
    maxLevel: 2,
    onLevelChange: vi.fn(),
  };

  it('renders with default classes, and stopPropagation onMouseDown works', () => {
    const { container, unmount } = render(createElement(CanvasZoomControls, defaultProps));

    const mainDiv = container.querySelector('.canvas-controls');
    expect(mainDiv).not.toBeNull();
    expect(mainDiv.className).toBe('canvas-controls');

    const mouseDownEvent = new MouseEvent('mousedown', { bubbles: true });
    vi.spyOn(mouseDownEvent, 'stopPropagation');
    act(() => {
      mainDiv.dispatchEvent(mouseDownEvent);
    });
    expect(mouseDownEvent.stopPropagation).toHaveBeenCalled();

    unmount();
  });

  it('can toggle folded and horizontal classes', () => {
    const { container, unmount } = render(createElement(CanvasZoomControls, defaultProps));

    const mainDiv = container.querySelector('.canvas-controls');

    // Header buttons
    const headerBtns = container.querySelectorAll('.canvas-controls-header button');
    const foldBtn = headerBtns[0];
    const horizontalBtn = headerBtns[1];

    expect(mainDiv.className).not.toContain('is-folded');
    expect(mainDiv.className).not.toContain('is-horizontal');

    // Click fold
    act(() => {
      foldBtn.click();
    });
    expect(mainDiv.className).toContain('is-folded');

    // Click horizontal
    act(() => {
      horizontalBtn.click();
    });
    expect(mainDiv.className).toContain('is-horizontal');

    unmount();
  });

  it('triggers onClose', () => {
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasZoomControls, { ...defaultProps, onClose }),
    );

    const closeBtn = container.querySelector('.canvas-close-btn');
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();

    unmount();
  });

  it('triggers navigate and zoom callbacks in body', () => {
    const onNavigate = vi.fn();
    const onZoomIn = vi.fn();
    const onZoomOut = vi.fn();
    const onReset = vi.fn();
    const onToggleSummaryMode = vi.fn();

    const { container, unmount } = render(
      createElement(CanvasZoomControls, {
        ...defaultProps,
        onNavigate,
        onZoomIn,
        onZoomOut,
        onReset,
        onToggleSummaryMode,
      }),
    );

    const bodyBtns = container.querySelectorAll('.canvas-controls-body button');
    const navigationGrid = container.querySelector('.canvas-navigation-grid');
    expect(navigationGrid).not.toBeNull();

    const navigationBtns = navigationGrid.querySelectorAll('button');
    expect(Array.from(navigationBtns).map((button) => button.title)).toEqual([
      'First topic',
      'Scroll to top',
      'Previous topic',
      'Previous page',
      'Next topic',
      'Next page',
      'Last topic',
      'Scroll to bottom',
    ]);

    // First topic
    act(() => bodyBtns[0].click());
    expect(onNavigate).toHaveBeenCalledWith('first-topic');

    // Scroll to top
    act(() => bodyBtns[1].click());
    expect(onNavigate).toHaveBeenCalledWith('top');

    // Scroll to prev
    act(() => bodyBtns[3].click());
    expect(onNavigate).toHaveBeenCalledWith('prev');

    // Previous topic
    act(() => bodyBtns[2].click());
    expect(onNavigate).toHaveBeenCalledWith('prev-topic');

    // Next topic
    act(() => bodyBtns[4].click());
    expect(onNavigate).toHaveBeenCalledWith('next-topic');

    // Scroll to next
    act(() => bodyBtns[5].click());
    expect(onNavigate).toHaveBeenCalledWith('next');

    // Last topic
    act(() => bodyBtns[6].click());
    expect(onNavigate).toHaveBeenCalledWith('last-topic');

    // Scroll to bottom
    act(() => bodyBtns[7].click());
    expect(onNavigate).toHaveBeenCalledWith('bottom');

    // Zoom in
    act(() => bodyBtns[8].click());
    expect(onZoomIn).toHaveBeenCalled();

    // Zoom out
    act(() => bodyBtns[9].click());
    expect(onZoomOut).toHaveBeenCalled();

    // Reset zoom
    act(() => bodyBtns[10].click());
    expect(onReset).toHaveBeenCalled();

    // Toggle summary mode
    act(() => bodyBtns[11].click());
    expect(onToggleSummaryMode).toHaveBeenCalled();

    unmount();
  });

  it('conditionally renders switcher when showTopicHierarchy is true', () => {
    const onLevelChange = vi.fn();
    const onToggleTopicHierarchy = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasZoomControls, {
        ...defaultProps,
        showTopicHierarchy: true,
        onLevelChange,
        onToggleTopicHierarchy,
      }),
    );

    // Switcher should exist
    const switcher = container.querySelector('.topic-level-switcher');
    expect(switcher).not.toBeNull();

    const buttons = container.querySelectorAll('.topic-level-switcher__button');
    act(() => {
      buttons[0].click();
    });
    expect(onLevelChange).toHaveBeenCalledWith(0);

    const hierarchyBtn = container.querySelector('.canvas-control-hierarchy-group > button');
    act(() => {
      hierarchyBtn.click();
    });
    expect(onToggleTopicHierarchy).toHaveBeenCalled();

    unmount();
  });
});
