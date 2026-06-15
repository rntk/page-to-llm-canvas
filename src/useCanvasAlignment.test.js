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

function setup({ wrapRect, anchorRect }) {
  const wrapEl = document.createElement('div');
  const anchorEl = document.createElement('div');
  const rects = { wrap: { ...wrapRect }, anchor: { ...anchorRect } };
  wrapEl.getBoundingClientRect = () => rects.wrap;
  anchorEl.getBoundingClientRect = () => rects.anchor;

  const anchorRef = { current: anchorEl };
  const wrapElRef = { current: wrapEl };
  const translateRef = { current: { x: 40, y: 40 } };
  const scaleRef = { current: 1 };
  const setTransformNow = vi.fn((s, t) => {
    translateRef.current = t;
  });

  const apiRef = { current: null };
  function Harness({ d }) {
    apiRef.current = useCanvasAlignment({
      enabled: true,
      anchorRef,
      wrapElRef,
      setTransformNow,
      translateRef,
      scaleRef,
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
    render,
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
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
    // → dx 50; top pinned to margin 40 → dy -160.
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 90, y: -120 });
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
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 240, y: 40 });
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
    // → dy = 40 - 300 = -260.
    expect(ctx.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.translateRef.current).toEqual({ x: 40, y: -220 });
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
});
