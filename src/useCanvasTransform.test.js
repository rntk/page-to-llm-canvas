// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useCanvasTransform, clampScale, cursorAnchoredTranslate } from './useCanvasTransform.js';

function renderHook(callback) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let result = { current: null };
  function TestComponent() {
    result.current = callback();
    return null;
  }
  const root = createRoot(container);
  act(() => root.render(createElement(TestComponent)));
  return {
    result,
    rerender() {
      act(() => root.render(createElement(TestComponent)));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

// ---------------------------------------------------------------------------
// clampScale
// ---------------------------------------------------------------------------

describe('clampScale', () => {
  it('returns 1 for non-finite values', () => {
    expect(clampScale(NaN)).toBe(1);
    expect(clampScale(Infinity)).toBe(1);
    expect(clampScale(-Infinity)).toBe(1);
  });

  it('returns 1 for undefined', () => {
    expect(clampScale(undefined)).toBe(1);
  });

  it('clamps to MIN_SCALE (0.3) for small values', () => {
    expect(clampScale(0)).toBe(0.3);
    expect(clampScale(0.1)).toBe(0.3);
    expect(clampScale(-5)).toBe(0.3);
  });

  it('clamps to MAX_SCALE (3) for large values', () => {
    expect(clampScale(5)).toBe(3);
    expect(clampScale(100)).toBe(3);
  });

  it('passes through values within range', () => {
    expect(clampScale(1)).toBe(1);
    expect(clampScale(0.5)).toBe(0.5);
    expect(clampScale(2)).toBe(2);
  });

  it('allows exactly MIN_SCALE', () => {
    expect(clampScale(0.3)).toBe(0.3);
  });

  it('allows exactly MAX_SCALE', () => {
    expect(clampScale(3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// cursorAnchoredTranslate
// ---------------------------------------------------------------------------

describe('cursorAnchoredTranslate', () => {
  it('zooms toward the cursor anchor point', () => {
    const result = cursorAnchoredTranslate({
      cursor: { x: 100, y: 100 },
      translate: { x: 0, y: 0 },
      currentScale: 1,
      nextScale: 2,
    });
    expect(result.x).toBe(-100);
    expect(result.y).toBe(-100);
  });

  it('works with non-zero translate', () => {
    const result = cursorAnchoredTranslate({
      cursor: { x: 100, y: 100 },
      translate: { x: 10, y: 20 },
      currentScale: 1,
      nextScale: 2,
    });
    expect(result.x).toBe(-80);
    expect(result.y).toBe(-60);
  });

  it('returns original translate when scale does not change', () => {
    const result = cursorAnchoredTranslate({
      cursor: { x: 100, y: 100 },
      translate: { x: 10, y: 20 },
      currentScale: 1,
      nextScale: 1,
    });
    expect(result.x).toBe(10);
    expect(result.y).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// useCanvasTransform hook
// ---------------------------------------------------------------------------

describe('useCanvasTransform', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => {
      return setTimeout(fn, 0);
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initializes with default transform', () => {
    const { result } = renderHook(() => useCanvasTransform());
    expect(result.current.translate).toEqual({ x: 40, y: 40 });
    expect(result.current.scale).toBe(1);
    expect(result.current.isCanvasDragging).toBe(false);
    expect(result.current.isFocusingHighlight).toBe(false);
  });

  it('setTransformNow updates scale and translate synchronously', () => {
    const { result } = renderHook(() => useCanvasTransform());
    act(() => {
      result.current.setTransformNow(1.5, { x: 100, y: 200 });
    });
    expect(result.current.scale).toBe(1.5);
    expect(result.current.translate).toEqual({ x: 100, y: 200 });
  });

  it('ArrowUp keyboard pan offsets translate upward', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const keyDown = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(keyDown);
    });
    expect(result.current.translate).toEqual({ x: 40, y: 120 });
    expect(result.current.isFocusingHighlight).toBe(true);
  });

  it('zoomToTarget calculates transform from target rect', () => {
    const contentRef = { current: document.createElement('div') };
    const { result } = renderHook(() => useCanvasTransform({ contentRef }));

    const wrap = document.createElement('div');
    const viewport = document.createElement('div');
    document.body.appendChild(wrap);
    document.body.appendChild(viewport);

    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });

    const targetRect = { top: 100, left: 100, width: 50, height: 50 };
    act(() => {
      result.current.zoomToTarget(targetRect, 1.5);
    });

    expect(result.current.scale).toBe(1.5);
    expect(result.current.translate).not.toEqual({ x: 40, y: 40 });
  });

  it('zoomToTarget re-pins the content left edge after a zoom-induced reflow', async () => {
    // Regression: the article column's left padding is zoom-adjusted (sized
    // 1/scale to stay screen-constant), so zooming IN from a zoomed-out state
    // collapses the gutter and the content slides left *after* the transform
    // applies. zoomToTarget must re-pin the content's left edge from the
    // settled layout, or the zoom lands on the rail instead of the sentence.
    const content = document.createElement('div');
    let contentLeft = 300; // pre-reflow position at the inflated gutter
    content.getBoundingClientRect = () => ({ left: contentLeft, top: 0, width: 0, height: 0 });
    const contentRef = { current: content };
    const { result } = renderHook(() => useCanvasTransform({ contentRef }));

    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    const viewport = document.createElement('div');
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });

    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });

    // Start zoomed out so zooming in collapses the gutter.
    act(() => {
      result.current.setTransformNow(0.3, { x: 0, y: 0 });
    });

    act(() => {
      result.current.zoomToTarget({ top: 100, left: 320, width: 50, height: 50 }, 1.5);
    });

    // Initial placement from the inflated (pre-reflow) layout:
    // localContentX = (300 - 0) / 0.3 = 1000; nextX = 40 - 1000 * 1.5 = -1460.
    expect(result.current.scale).toBe(1.5);
    expect(result.current.translate.x).toBe(-1460);
    const pinnedY = result.current.translate.y;

    // The scale change reflows: the gutter collapses and the content settles.
    contentLeft = 200;

    // Flush the queued rAF (mocked as setTimeout(fn, 0)).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    // Re-pinned to the settled content edge: 40 - (200 - 0) = -160, y unchanged.
    expect(result.current.translate.x).toBe(-160);
    expect(result.current.translate.y).toBe(pinnedY);
  });

  it('navigateCanvas moves to top', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    act(() => {
      result.current.canvasWrapRef(wrap);
    });

    act(() => {
      result.current.navigateCanvas('top');
    });
    expect(result.current.translate.y).toBe(40);
  });

  it('handleMouseDown sets dragging state', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const mouseDown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    act(() => {
      result.current.handleMouseDown(mouseDown);
    });
    expect(result.current.isCanvasDragging).toBe(true);
  });

  it('body gets dragging class while dragging and removes on unmount', () => {
    const { result, unmount } = renderHook(() => useCanvasTransform());
    const mouseDown = new MouseEvent('mousedown', {
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    act(() => {
      result.current.handleMouseDown(mouseDown);
    });
    expect(document.body.classList.contains('canvas-global-dragging')).toBe(true);
    unmount();
    expect(document.body.classList.contains('canvas-global-dragging')).toBe(false);
  });

  it('wheel zoom listener is attached when canvas wrap mounts', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const wrap = document.createElement('div');
    const addSpy = vi.spyOn(wrap, 'addEventListener');
    document.body.appendChild(wrap);
    act(() => {
      result.current.canvasWrapRef(wrap);
    });
    expect(addSpy).toHaveBeenCalledWith('wheel', expect.any(Function), { passive: false });
  });

  it('keyboard navigation triggers navigateCanvas for Home key', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    act(() => {
      result.current.canvasWrapRef(wrap);
    });

    const keyDown = new KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(keyDown);
    });
    expect(result.current.translate.y).toBe(40);
  });

  it('keyboard pan triggers panBy for ArrowUp', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const keyDown = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      bubbles: true,
    });
    act(() => {
      window.dispatchEvent(keyDown);
    });
    expect(result.current.translate.y).toBe(40 + 80);
  });

  it('ignores keyboard events when target is an input', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const input = document.createElement('input');
    document.body.appendChild(input);
    const keyDown = new KeyboardEvent('keydown', {
      key: 'Home',
      bubbles: true,
    });
    act(() => {
      input.dispatchEvent(keyDown);
    });
    // Should still be default because listener checks target tagName
    expect(result.current.translate).toEqual({ x: 40, y: 40 });
  });
});
