// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useCanvasTransform } from './useCanvasTransform.js';
import { clampScale, cursorAnchoredTranslate } from '../../utils/canvasMath.js';

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

  it('clamps to MIN_SCALE (0.1) for small values', () => {
    expect(clampScale(0)).toBe(0.1);
    expect(clampScale(0.05)).toBe(0.1);
    expect(clampScale(-5)).toBe(0.1);
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
    expect(clampScale(0.1)).toBe(0.1);
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
      result.current.viewport.setTransformNow(1.5, { x: 100, y: 200 });
    });
    expect(result.current.scale).toBe(1.5);
    expect(result.current.translate).toEqual({ x: 100, y: 200 });
  });

  it('keeps the reading surface fixed when scale-dependent layout reflows', () => {
    const content = document.createElement('div');
    const contentRef = { current: content };
    const hook = renderHook(() => useCanvasTransform({ contentRef }));
    const viewport = document.createElement('div');

    // Model the inverse-scaled left gutter: committing scale 2 moves the
    // article from layout-x 100 to layout-x 50.
    const localContentX = () => (hook.result.current.scale === 2 ? 50 : 100);
    viewport.getBoundingClientRect = () => ({
      left: hook.result.current.viewport.translateRef.current.x,
      top: hook.result.current.viewport.translateRef.current.y,
      width: 800,
      height: 600,
    });
    content.getBoundingClientRect = () => ({
      left:
        hook.result.current.viewport.translateRef.current.x +
        localContentX() * hook.result.current.viewport.scaleRef.current,
      top: hook.result.current.viewport.translateRef.current.y,
      width: 680,
      height: 1000,
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      transform: `matrix(${hook.result.current.viewport.scaleRef.current}, 0, 0, ${hook.result.current.viewport.scaleRef.current}, 0, 0)`,
    }));

    act(() => hook.result.current.canvasViewportRef(viewport));
    act(() => hook.result.current.viewport.zoomAtPoint({ x: 100, y: 100 }, 2));

    expect(hook.result.current.scale).toBe(2);
    expect(hook.result.current.isCardZoomSmoothing).toBe(true);
    // The raw cursor transform would be x=-20. Correcting the 50px layout
    // reflow places the article at the same predicted screen-x (180px).
    expect(hook.result.current.translate.x).toBe(80);
  });

  it('keeps the viewport handle stable and limited to the imperative surface', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const first = result.current.viewport;
    act(() => {
      result.current.viewport.setTransformNow(1.5, { x: 100, y: 200 });
    });
    // Guards against a vacuous identity check: the transform really did commit a
    // new render, and the handle still survived it unchanged. Its memo must not
    // depend on the transform, or every pan/zoom would re-run consumers' effects.
    expect(result.current.scale).toBe(1.5);
    expect(result.current.viewport).toBe(first);
    expect(Object.keys(result.current.viewport).sort()).toEqual([
      'canvasWrapElRef',
      'scaleRef',
      'setTransformNow',
      'translateRef',
      'userMovedCanvasRef',
      'zoomAtPoint',
      'zoomToTarget',
    ]);
    // Bundled, not duplicated: the handle's members are gone from the flat return.
    expect(result.current.scaleRef).toBeUndefined();
    expect(result.current.setTransformNow).toBeUndefined();
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
    // Pan flashes the focus glow but must NOT mark a zoom-to-target: that flag
    // gates the expensive sentence remeasurement, which a pan never needs.
    expect(result.current.isZoomingToTarget).toBe(false);
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
      result.current.viewport.zoomToTarget(targetRect, 1.5);
    });

    expect(result.current.scale).toBe(1.5);
    expect(result.current.translate).not.toEqual({ x: 40, y: 40 });
    // A real zoom (scale change) must suppress sentence measurement until the
    // transition settles; the flag's false-flip later drives the remeasure.
    expect(result.current.isZoomingToTarget).toBe(true);
  });

  it('zoomToTarget places the canvas from the settled (post-reflow) layout', () => {
    // Regression: the summary gutter and the rail cards are sized 1/scale to
    // stay screen-constant, so the reading column's layout-x is itself a
    // function of the scale — 4460px at scale 0.1, 482px at 1.5. Zooming in from
    // a zoomed-out state therefore reflows the layout out from under the
    // placement, and placing the canvas from the pre-zoom measurement stranded
    // the article thousands of px off (which edge depended on the rule). The
    // placement must be recomputed once the new scale's layout has committed.
    //
    // The fake canvas below models that relationship: `layoutScale` (what the
    // committed React state reflows to) is deliberately distinct from
    // `applied.scale` (the mid-transition transform the rects are measured
    // through), exactly as in the browser.
    const COLUMN = 772;
    const RAIL = 500;
    const gutterFor = (layoutScale) => 442 * Math.max(1, 1 / layoutScale) + 40;

    function mountFakeCanvas({ wrapWidth }) {
      const content = document.createElement('div');
      Object.defineProperty(content, 'offsetWidth', { value: COLUMN, configurable: true });
      const contentRef = { current: content };
      const hook = renderHook(() => useCanvasTransform({ contentRef }));

      // Mid-transition transform: the DOM still carries the pre-zoom scale.
      const applied = { scale: 1 };
      const layoutScale = () => hook.result.current.scale;
      const translateX = () => hook.result.current.translate.x;
      const groupLocal = () => gutterFor(layoutScale()) + COLUMN + RAIL;

      const wrap = document.createElement('div');
      wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: wrapWidth, height: 1000 });
      const viewport = document.createElement('div');
      viewport.getBoundingClientRect = () => ({
        left: translateX(),
        top: 0,
        width: groupLocal() * applied.scale,
        height: 1000,
      });
      content.getBoundingClientRect = () => ({
        left: translateX() + gutterFor(layoutScale()) * applied.scale,
        top: 0,
        width: COLUMN * applied.scale,
        height: 100,
      });
      vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
        el === viewport
          ? { transform: `matrix(${applied.scale}, 0, 0, ${applied.scale}, 0, 0)` }
          : { transform: 'none' },
      );

      act(() => {
        hook.result.current.canvasWrapRef(wrap);
        hook.result.current.canvasViewportRef(viewport);
      });
      return { hook, applied, groupLocal };
    }

    // Narrow canvas: the whole layout cannot fit, so the reading column is
    // framed and the rail is allowed to fall outside.
    {
      const { hook, applied } = mountFakeCanvas({ wrapWidth: 1000 });
      act(() => {
        hook.result.current.viewport.setTransformNow(0.1, { x: 0, y: 0 });
      });
      applied.scale = 0.1;

      act(() => {
        hook.result.current.viewport.zoomToTarget({ top: 100, left: 50, width: 5, height: 5 }, 1.5);
      });

      // Settled layout at 1.5: gutter 482, column 772 * 1.5 = 1158 wide — wider
      // than the usable width (1000 - 48), so the column's left edge is pinned
      // one edge-margin in: x = 24 - 482 * 1.5 = -699. The pre-reflow layout
      // (gutter 4460 at scale 0.1) would have placed it at 24 - 4460 * 1.5,
      // i.e. ~6000px off screen.
      expect(hook.result.current.scale).toBe(1.5);
      expect(hook.result.current.translate.x).toBeCloseTo(-699, 5);
      hook.unmount();
    }

    // Wide canvas: the whole layout fits, so gutter *and* rail stay on screen.
    {
      const { hook, applied, groupLocal } = mountFakeCanvas({ wrapWidth: 3000 });
      act(() => {
        hook.result.current.viewport.setTransformNow(0.1, { x: 0, y: 0 });
      });
      applied.scale = 0.1;

      act(() => {
        hook.result.current.viewport.zoomToTarget({ top: 100, left: 50, width: 5, height: 5 }, 1.5);
      });

      // group = (482 + 772 + 500) * 1.5 = 2631, centred in 3000.
      const groupWidth = groupLocal() * 1.5;
      expect(hook.result.current.translate.x).toBeCloseTo((3000 - groupWidth) / 2, 5);
      // The rail's right edge stays inside the canvas — the reported symptom was
      // the rail being pushed out past the right border.
      expect(hook.result.current.translate.x + groupWidth).toBeLessThanOrEqual(3000);
      hook.unmount();
    }

    // Second click while the first zoom is still animating: the scale is already
    // at the target, so nothing reflows and no settled-layout pass runs — the
    // placement has to be right first time, measured through the *mid-flight*
    // transform (0.9 here, not the 1.5 the canvas is heading for).
    {
      const { hook, applied } = mountFakeCanvas({ wrapWidth: 1000 });
      act(() => {
        hook.result.current.viewport.setTransformNow(1.5, { x: -200, y: 0 });
      });
      applied.scale = 0.9;

      act(() => {
        hook.result.current.viewport.zoomToTarget({ top: 100, left: 50, width: 5, height: 5 }, 1.5);
      });

      // Same settled layout as the narrow case above, so the same placement:
      // unscaling by 1.5 instead of the applied 0.9 would inflate the column's
      // local-x by 1.67x and land it hundreds of px off.
      expect(hook.result.current.translate.x).toBeCloseTo(-699, 5);
      hook.unmount();
    }
  });

  it('zoomToTarget frames the reading column and leaves later moves alone', () => {
    const content = document.createElement('div');
    Object.defineProperty(content, 'offsetWidth', { value: 400, configurable: true });
    content.getBoundingClientRect = () => ({ left: 200, top: 0, width: 400, height: 100 });
    const contentRef = { current: content };
    const { result } = renderHook(() => useCanvasTransform({ contentRef }));

    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 1000 });
    const viewport = document.createElement('div');
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 2000, height: 1000 });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el) =>
      el === viewport ? { transform: 'matrix(1, 0, 0, 1, 0, 0)' } : { transform: 'none' },
    );

    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });
    act(() => {
      result.current.viewport.setTransformNow(1, { x: -100, y: 0 });
    });

    act(() => {
      result.current.viewport.zoomToTarget({ top: 100, left: 220, width: 50, height: 20 }, 1.5);
    });
    // The group (2000 * 1.5) does not fit, but the column (400 * 1.5 = 600)
    // does, so it is centred: x = (1000 - 600) / 2 - 200 * 1.5 = -100. The old
    // rule pinned the column flush left (40 - 300 = -260), which is what pushed
    // the text off the left edge of the canvas.
    expect(result.current.translate.x).toBe(-100);

    // The settled-layout placement fires for the zoom's own scale commit only:
    // a later zoom or pan of any other origin must not be re-placed.
    act(() => {
      result.current.viewport.setTransformNow(2, { x: 777, y: 0 });
    });
    expect(result.current.translate.x).toBe(777);
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

  it('navigateCanvas bottom/prev/next adjust y using viewport and content rects', () => {
    const content = document.createElement('div');
    content.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      bottom: 800,
      width: 100,
      height: 800,
    });
    const contentRef = { current: content };

    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });
    // Make clientHeight match the rect so pageStep uses the mocked height (500 * 0.8 = 400)
    Object.defineProperty(wrap, 'clientHeight', { value: 500, configurable: true });

    const viewport = document.createElement('div');
    viewport.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500 });

    const { result } = renderHook(() => useCanvasTransform({ contentRef }));
    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });

    // bottom: content.bottom - viewport.top = 800; nextY = min(40, 500 - 800 - 40) = min(40, -340) = -340
    act(() => result.current.navigateCanvas('bottom'));
    expect(result.current.translate.y).toBe(-340);

    // prev (from -340): -340 + pageStep(400) = 60
    act(() => result.current.navigateCanvas('prev'));
    expect(result.current.translate.y).toBe(60);

    // next (from 60): 60 - 400 = -340
    act(() => result.current.navigateCanvas('next'));
    expect(result.current.translate.y).toBe(-340);
  });

  it('wheel zoom stays cursor-anchored and commits after the input burst', async () => {
    const onVisualScaleChange = vi.fn();
    const { result } = renderHook(() => useCanvasTransform({ onVisualScaleChange }));
    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 25, top: 40, width: 800, height: 600 });
    const viewport = document.createElement('div');
    document.body.appendChild(wrap);
    document.body.appendChild(viewport);
    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });

    const cursor = { x: 100 - 25, y: 100 - 40 };
    const originalCanvasPoint = {
      x: (cursor.x - 40) / 1,
      y: (cursor.y - 40) / 1,
    };
    const wheelOut = new WheelEvent('wheel', {
      deltaY: 120,
      bubbles: true,
    });
    // happy-dom does not currently copy pointer coordinates from WheelEventInit.
    Object.defineProperties(wheelOut, {
      clientX: { value: 100 },
      clientY: { value: 100 },
    });
    act(() => {
      wrap.dispatchEvent(wheelOut);
    });
    const liveScale = result.current.viewport.scaleRef.current;
    const liveTranslate = result.current.viewport.translateRef.current;
    expect((cursor.x - liveTranslate.x) / liveScale).toBeCloseTo(originalCanvasPoint.x);
    expect((cursor.y - liveTranslate.y) / liveScale).toBeCloseTo(originalCanvasPoint.y);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    expect(onVisualScaleChange).toHaveBeenLastCalledWith(liveScale);
    // React state is intentionally deferred so the expensive canvas subtree is
    // not rendered once per wheel event.
    expect(result.current.scale).toBe(1);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(result.current.scale).toBeLessThan(1);
    // Wheel cards track the live scale directly; no delayed settle transition
    // should remain to create a second movement after the gesture.
    expect(result.current.isCardZoomSmoothing).toBe(false);
    expect(viewport.style.getPropertyValue('--canvas-scale')).toBe(`${liveScale}`);

    const wheelIn = new WheelEvent('wheel', {
      deltaY: -120,
      bubbles: true,
    });
    Object.defineProperties(wheelIn, {
      clientX: { value: 100 },
      clientY: { value: 100 },
    });
    act(() => {
      wrap.dispatchEvent(wheelIn);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(result.current.scale).toBeGreaterThanOrEqual(0.1);
  });

  it('preserves fine-grained trackpad wheel deltas', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    document.body.appendChild(wrap);
    act(() => result.current.canvasWrapRef(wrap));

    const trackpadWheel = new WheelEvent('wheel', { deltaY: -1 });
    Object.defineProperties(trackpadWheel, {
      clientX: { value: 200 },
      clientY: { value: 150 },
    });
    act(() => wrap.dispatchEvent(trackpadWheel));

    expect(result.current.viewport.scaleRef.current).toBeCloseTo(Math.exp(0.0008), 8);
  });

  it('corrects live card reflow in the same wheel frame', async () => {
    let localContentX = 100;
    const content = document.createElement('div');
    const contentRef = { current: content };
    const onVisualScaleChange = vi.fn((visualScale) => {
      if (visualScale !== 1) localContentX = 150;
    });
    const { result } = renderHook(() => useCanvasTransform({ contentRef, onVisualScaleChange }));
    const wrap = document.createElement('div');
    const viewport = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    viewport.getBoundingClientRect = () => ({
      left: result.current.viewport.translateRef.current.x,
      top: result.current.viewport.translateRef.current.y,
      width: 800,
      height: 600,
    });
    content.getBoundingClientRect = () => ({
      left:
        result.current.viewport.translateRef.current.x +
        localContentX * result.current.viewport.scaleRef.current,
      top: result.current.viewport.translateRef.current.y,
      width: 680,
      height: 1000,
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => ({
      transform: `matrix(${result.current.viewport.scaleRef.current}, 0, 0, ${result.current.viewport.scaleRef.current}, 0, 0)`,
    }));
    document.body.append(wrap, viewport, content);
    act(() => {
      result.current.canvasWrapRef(wrap);
      result.current.canvasViewportRef(viewport);
    });

    const wheel = new WheelEvent('wheel', { deltaY: 120 });
    Object.defineProperties(wheel, {
      clientX: { value: 100 },
      clientY: { value: 100 },
    });
    act(() => wrap.dispatchEvent(wheel));
    const visualScale = result.current.viewport.scaleRef.current;
    const expectedContentLeft =
      cursorAnchoredTranslate({
        cursor: { x: 100, y: 100 },
        translate: { x: 40, y: 40 },
        currentScale: 1,
        nextScale: visualScale,
      }).x +
      100 * visualScale;

    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));

    expect(content.getBoundingClientRect().left).toBeCloseTo(expectedContentLeft);
    expect(result.current.scale).toBe(1);
  });

  it('wheel with no effective scale change early returns without updating', () => {
    const { result } = renderHook(() => useCanvasTransform());
    const wrap = document.createElement('div');
    wrap.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
    document.body.appendChild(wrap);
    act(() => {
      result.current.canvasWrapRef(wrap);
    });

    // Force current scale to MIN so further WHEEL_OUT produces no change
    act(() => {
      result.current.viewport.setTransformNow(0.1, { x: 0, y: 0 });
    });
    const before = { ...result.current.translate };

    const wheelOut = new WheelEvent('wheel', { deltaY: 120, clientX: 50, clientY: 50 });
    act(() => {
      wrap.dispatchEvent(wheelOut);
    });
    expect(result.current.translate).toEqual(before);
  });
});
