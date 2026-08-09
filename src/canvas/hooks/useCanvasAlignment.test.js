// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { computeComfortLeft, useCanvasAlignment } from './useCanvasAlignment.js';

// wrapWidth 1000 → center 500, dead-zone ±150, edge margin 24.
const WRAP = 1000;
const COL = 400; // column center offset 200

describe('computeComfortLeft', () => {
  it('leaves a centered column untouched', () => {
    const left = (WRAP - COL) / 2; // 300, center at 500
    expect(computeComfortLeft(left, COL, WRAP)).toBeCloseTo(left);
  });

  it('does not move while the column center stays inside the dead-zone', () => {
    // center at 500 + 120 (< 150) → left 420
    const left = 420;
    expect(computeComfortLeft(left, COL, WRAP)).toBeCloseTo(left);
  });

  it('nudges only to the dead-zone edge, not to dead center', () => {
    // center at 500 + 250 → left 550, outside dead-zone by 100.
    // target center = 500 + 150 = 650 → left 450.
    expect(computeComfortLeft(550, COL, WRAP)).toBeCloseTo(450);
  });

  it('keeps both edges within the margin', () => {
    expect(computeComfortLeft(2000, COL, WRAP)).toBeLessThanOrEqual(WRAP - 24 - COL);
    expect(computeComfortLeft(2000, COL, WRAP)).toBeGreaterThanOrEqual(24);
    expect(computeComfortLeft(-2000, COL, WRAP)).toBeGreaterThanOrEqual(24);
  });

  it('only rescues the left edge for a column wider than the viewport', () => {
    const wide = 1200;
    // left edge off-screen → pull to margin
    expect(computeComfortLeft(-100, wide, WRAP)).toBeCloseTo(24);
    // left edge visible → leave it (no forced centering of an oversized column)
    expect(computeComfortLeft(10, wide, WRAP)).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// Integration: exercise the real align() runtime path with non-zero rects
// (happy-dom, like jsdom, returns zero rects by default, which would make the
// hook inert — so we stub getBoundingClientRect on the anchor and wrap).
// ---------------------------------------------------------------------------

function setup({ wrapRect, anchorRect, autoRaf = true }) {
  // By default the deferred (animated) move runs synchronously so its result is
  // observable right after render() in act(). Timing-sensitive tests can opt
  // into a manual queue.
  const origRaf = window.requestAnimationFrame;
  const origCancel = window.cancelAnimationFrame;
  const rafQueue = new Map();
  let rafId = 0;
  window.requestAnimationFrame = (cb) => {
    if (autoRaf) {
      cb();
      return 0;
    }
    rafId += 1;
    rafQueue.set(rafId, cb);
    return rafId;
  };
  window.cancelAnimationFrame = (id) => {
    rafQueue.delete(id);
  };

  const wrapEl = document.createElement('div');
  const anchorEl = document.createElement('div');
  const rects = { wrap: { ...wrapRect }, anchor: { ...anchorRect } };
  wrapEl.getBoundingClientRect = () => rects.wrap;
  anchorEl.getBoundingClientRect = () => rects.anchor;

  const anchorRef = { current: anchorEl };
  const wrapElRef = { current: wrapEl };
  const translateRef = { current: { x: 40, y: 40 } };
  const scaleRef = { current: 1 };
  const flashFocus = vi.fn();
  const setTransformNow = vi.fn((s, t) => {
    translateRef.current = t;
  });

  // The hook now takes the transform's single imperative handle. Built once, as
  // the real hook memoizes it, so re-rendering the harness never re-runs effects
  // that key on it.
  const viewport = {
    canvasWrapElRef: wrapElRef,
    setTransformNow,
    translateRef,
    scaleRef,
    userMovedCanvasRef: { current: false },
    zoomToTarget: vi.fn(),
  };

  const apiRef = { current: null };
  function Harness({ d }) {
    apiRef.current = useCanvasAlignment({
      anchorRef,
      viewport,
      flashFocus,
      deps: [d],
    });
    return null;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (d) => act(() => root.render(createElement(Harness, { d })));

  return {
    rects,
    apiRef,
    translateRef,
    setTransformNow,
    flashFocus,
    render,
    flushRafs: () => {
      const callbacks = [...rafQueue.values()];
      rafQueue.clear();
      callbacks.forEach((cb) => cb());
    },
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
      window.requestAnimationFrame = origRaf;
      window.cancelAnimationFrame = origCancel;
    },
  };
}

describe('useCanvasAlignment runtime', () => {
  it('centers the reading column on the initial mount', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      // off-center left: column center 100+200=300, 200px left of viewport center.
      anchorRect: { left: 100, top: 200, width: COL, height: 600 },
    });
    ctx.render(1);

    // Comfort nudges to the dead-zone edge: target center 350 → target left 150
    // → dx 50; top pinned to margin 40 → dy -160. Initial center is instant.
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 90, y: -120 });
    expect(ctx.flashFocus).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('preserves the column position across a switch (no jump) via continuity', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      // centered to start → no initial transform.
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
    });
    ctx.render(1);
    expect(ctx.setTransformNow).not.toHaveBeenCalled();

    // User captures before a layout-affecting switch…
    act(() => ctx.apiRef.current.captureAnchor(false));
    // …then the switch reflows the column 200px to the left (e.g. a left gutter
    // collapsing). Without continuity this is the visible "jump".
    ctx.rects.anchor = { left: 100, top: 40, width: COL, height: 600 };
    ctx.render(2);

    // Continuity pans by +200 so the column lands back where it was on screen.
    // It's instant (no animation) — animating it would re-introduce the jump.
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 240, y: 40 });
    expect(ctx.flashFocus).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('resets the top margin on a content-swapping switch (resetTop)', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
    });
    ctx.render(1);

    act(() => ctx.apiRef.current.captureAnchor(true));
    // The swapped content lays out lower on the canvas.
    ctx.rects.anchor = { left: 300, top: 300, width: COL, height: 600 };
    ctx.render(2);

    // Horizontal preserved (still centered), vertical pulled back to margin 40
    // → dy = 40 - 300 = -260. The reset is the animated move (flashFocus).
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 40, y: -220 });
    expect(ctx.flashFocus).toHaveBeenCalledTimes(1);
    ctx.cleanup();
  });

  it('skips alignment for a switch positioned by another controller', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 100, top: 300, width: COL, height: 600 },
    });
    ctx.render(1); // initial center
    ctx.setTransformNow.mockClear();
    ctx.flashFocus.mockClear();

    // Hand positioning to a zoom: even though the layout shifts, the engine must
    // not pan — the other controller owns the final position.
    act(() => ctx.apiRef.current.skipNextAlignment());
    ctx.rects.anchor = { left: 700, top: 50, width: COL, height: 600 };
    ctx.render(2);
    expect(ctx.setTransformNow).not.toHaveBeenCalled();
    expect(ctx.flashFocus).not.toHaveBeenCalled();

    // …and a subsequent genuine switch aligns again.
    act(() => ctx.apiRef.current.captureAnchor(false));
    ctx.rects.anchor = { left: 100, top: 50, width: COL, height: 600 };
    ctx.render(3);
    expect(ctx.setTransformNow).toHaveBeenCalled();
    ctx.cleanup();
  });

  it('does not move when a centered column stays centered after a switch', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
    });
    ctx.render(1);
    act(() => ctx.apiRef.current.captureAnchor(false));
    ctx.render(2); // layout unchanged
    expect(ctx.setTransformNow).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('drops a stale anchor capture when the effect re-runs without a deps change', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
    });
    ctx.render(1);
    act(() => ctx.apiRef.current.captureAnchor(false));
    // Force a layout-effect re-run with the same deps (align identity changes on
    // re-render) but no real switch — the stale capture must not pan later.
    ctx.render(1);
    ctx.rects.anchor = { left: 100, top: 40, width: COL, height: 600 };
    ctx.render(1);
    expect(ctx.setTransformNow).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('cancels a pending animated move when skipNextAlignment runs before the switch', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
      autoRaf: false,
    });
    ctx.render(1);

    act(() => ctx.apiRef.current.captureAnchor(true));
    ctx.rects.anchor = { left: 300, top: 300, width: COL, height: 600 };
    ctx.render(2);
    expect(ctx.setTransformNow).not.toHaveBeenCalled();

    act(() => ctx.apiRef.current.skipNextAlignment());
    ctx.rects.anchor = { left: 700, top: 50, width: COL, height: 600 };
    ctx.render(3);
    ctx.flushRafs();

    expect(ctx.setTransformNow).not.toHaveBeenCalled();
    expect(ctx.flashFocus).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('cancels a stale deferred move when a newer switch has no animated move', () => {
    const ctx = setup({
      wrapRect: { left: 0, top: 0, width: WRAP, height: 800 },
      anchorRect: { left: 300, top: 40, width: COL, height: 600 },
      autoRaf: false,
    });
    ctx.render(1);

    act(() => ctx.apiRef.current.captureAnchor(true));
    ctx.rects.anchor = { left: 300, top: 300, width: COL, height: 600 };
    ctx.render(2);
    expect(ctx.setTransformNow).not.toHaveBeenCalled();

    // Before the deferred top reset runs, a newer layout switch keeps the
    // column centered and needs no animated follow-up. The old frame must not
    // survive and apply the obsolete top target afterwards.
    ctx.render(3);
    ctx.flushRafs();

    expect(ctx.setTransformNow).not.toHaveBeenCalled();
    expect(ctx.flashFocus).not.toHaveBeenCalled();
    ctx.cleanup();
  });
});
