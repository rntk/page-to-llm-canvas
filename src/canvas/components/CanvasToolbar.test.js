// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CanvasToolbar from './CanvasToolbar.jsx';

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

describe('CanvasToolbar', () => {
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
    const { container, unmount } = render(createElement(CanvasToolbar, defaultProps));

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
    const { container, unmount } = render(createElement(CanvasToolbar, defaultProps));

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
      createElement(CanvasToolbar, { ...defaultProps, onClose }),
    );

    const closeBtn = container.querySelector('.canvas-close-btn');
    act(() => {
      closeBtn.click();
    });
    expect(onClose).toHaveBeenCalled();

    unmount();
  });

  it('renders the navigation grid buttons in the expected order', () => {
    const { container, unmount } = render(createElement(CanvasToolbar, defaultProps));

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

    unmount();
  });

  it.each([
    ['First topic', 'first-topic'],
    ['Scroll to top', 'top'],
    ['Previous topic', 'prev-topic'],
    ['Previous page', 'prev'],
    ['Next topic', 'next-topic'],
    ['Next page', 'next'],
    ['Last topic', 'last-topic'],
    ['Scroll to bottom', 'bottom'],
  ])('clicking the "%s" button triggers onNavigate("%s")', (title, direction) => {
    const onNavigate = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onNavigate }),
    );

    const button = Array.from(container.querySelectorAll('.canvas-navigation-grid button')).find(
      (btn) => btn.title === title,
    );
    act(() => button.click());
    expect(onNavigate).toHaveBeenCalledWith(direction);

    unmount();
  });

  it('triggers onZoomIn when the zoom in button is clicked', () => {
    const onZoomIn = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onZoomIn }),
    );

    const zoomInBtn = Array.from(container.querySelectorAll('.canvas-zoom-btn')).find(
      (btn) => btn.title === 'Zoom in',
    );
    act(() => zoomInBtn.click());
    expect(onZoomIn).toHaveBeenCalled();

    unmount();
  });

  it('triggers onZoomOut when the zoom out button is clicked', () => {
    const onZoomOut = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onZoomOut }),
    );

    const zoomOutBtn = Array.from(container.querySelectorAll('.canvas-zoom-btn')).find(
      (btn) => btn.title === 'Zoom out',
    );
    act(() => zoomOutBtn.click());
    expect(onZoomOut).toHaveBeenCalled();

    unmount();
  });

  it('triggers onReset when the reset zoom button is clicked', () => {
    const onReset = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onReset }),
    );

    const resetBtn = Array.from(container.querySelectorAll('.canvas-zoom-btn')).find(
      (btn) => btn.title === 'Reset zoom',
    );
    act(() => resetBtn.click());
    expect(onReset).toHaveBeenCalled();

    unmount();
  });

  it('triggers onToggleSummaryMode when the summary mode toggle is clicked', () => {
    const onToggleSummaryMode = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onToggleSummaryMode }),
    );

    const summaryToggleBtn = container.querySelector('.canvas-view-toggle');
    act(() => summaryToggleBtn.click());
    expect(onToggleSummaryMode).toHaveBeenCalled();

    unmount();
  });

  it('conditionally renders switcher when showTopicHierarchy is true', () => {
    const onLevelChange = vi.fn();
    const onToggleTopicHierarchy = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, {
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

  it('shows the summary-mode toggle by default', () => {
    const { container, unmount } = render(createElement(CanvasToolbar, defaultProps));
    expect(
      Array.from(container.querySelectorAll('.canvas-view-toggle')).some(
        (button) => button.textContent === 'S',
      ),
    ).toBe(true);
    unmount();
  });

  it('hides the summary-mode toggle when summaryModeAvailable is false', () => {
    const onToggleSummaryMode = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, {
        ...defaultProps,
        summaryModeAvailable: false,
        onToggleSummaryMode,
      }),
    );

    // Chat and hierarchy remain; the summary ("S") toggle is gone.
    expect(container.querySelector('.canvas-chat-toggle')).not.toBeNull();
    const viewToggles = container.querySelectorAll('.canvas-view-toggle');
    expect(Array.from(viewToggles).map((button) => button.textContent)).toEqual(['H']);

    unmount();
  });

  it('toggles article chat', () => {
    const onToggleChat = vi.fn();
    const { container, unmount } = render(
      createElement(CanvasToolbar, { ...defaultProps, onToggleChat, showChat: true }),
    );
    const chatButton = container.querySelector('.canvas-chat-toggle');
    expect(chatButton.textContent).toBe('C');
    expect(chatButton.className).toContain('is-active');
    act(() => chatButton.click());
    expect(onToggleChat).toHaveBeenCalledOnce();
    unmount();
  });
});
