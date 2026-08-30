// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  useCanvasStartup,
  canvasStartupReducer,
  resolveStartupStep,
  REVEAL_TIMEOUT_MS,
  OVERLAY_FADE_MS,
  ENTRANCE_MS,
} from './useCanvasStartup.js';

function setup(initialProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let props = initialProps;
  const result = { current: null };
  function Harness() {
    result.current = useCanvasStartup(props);
    return null;
  }
  const root = createRoot(container);
  act(() => root.render(createElement(Harness)));
  return {
    result,
    rerender(overrides) {
      props = { ...props, ...overrides };
      act(() => root.render(createElement(Harness)));
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const preparing = { hasContent: true, layoutSettled: false, viewSettled: false };

describe('canvasStartupReducer', () => {
  it('only advances through the sequence once', () => {
    const start = { stage: 'preparing', isOverlayLeaving: false };
    const entering = canvasStartupReducer(start, 'reveal');
    expect(entering).toEqual({ stage: 'entering', isOverlayLeaving: true });
    // A second reveal (e.g. the deadline firing after the gates settled) is a
    // no-op rather than a restart of the entrance.
    expect(canvasStartupReducer(entering, 'reveal')).toBe(entering);

    const faded = canvasStartupReducer(entering, 'overlay-faded');
    expect(faded).toEqual({ stage: 'entering', isOverlayLeaving: false });
    expect(canvasStartupReducer(faded, 'overlay-faded')).toBe(faded);

    const done = canvasStartupReducer(faded, 'entrance-done');
    expect(done).toEqual({ stage: 'ready', isOverlayLeaving: false });
    expect(canvasStartupReducer(done, 'entrance-done')).toBe(done);
    expect(canvasStartupReducer(done, 'nonsense')).toBe(done);
  });
});

describe('resolveStartupStep', () => {
  it('reports the outstanding gate and never regresses', () => {
    const measuring = resolveStartupStep({
      isReady: false,
      layoutSettled: false,
      viewSettled: false,
    });
    const arranging = resolveStartupStep({
      isReady: false,
      layoutSettled: true,
      viewSettled: false,
    });
    const last = resolveStartupStep({ isReady: false, layoutSettled: true, viewSettled: true });
    const ready = resolveStartupStep({ isReady: true, layoutSettled: false, viewSettled: false });
    expect(measuring.progress).toBeLessThan(arranging.progress);
    expect(arranging.progress).toBeLessThan(last.progress);
    expect(ready.progress).toBe(1);
    expect(measuring.label).toBeTruthy();
  });
});

describe('useCanvasStartup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('covers the canvas until both gates settle, then reveals once', () => {
    const ctx = setup(preparing);
    expect(ctx.result.current.isReady).toBe(false);
    expect(ctx.result.current.showOverlay).toBe(true);

    // One gate alone is not enough.
    ctx.rerender({ layoutSettled: true });
    expect(ctx.result.current.isReady).toBe(false);
    expect(ctx.result.current.progress).toBeGreaterThan(0.28);

    ctx.rerender({ viewSettled: true });
    expect(ctx.result.current.isReady).toBe(true);
    expect(ctx.result.current.isEntering).toBe(true);
    expect(ctx.result.current.progress).toBe(1);
    // The overlay stays mounted through its fade so the two crossfade.
    expect(ctx.result.current.showOverlay).toBe(true);
    expect(ctx.result.current.isOverlayLeaving).toBe(true);

    act(() => vi.advanceTimersByTime(OVERLAY_FADE_MS));
    expect(ctx.result.current.showOverlay).toBe(false);
    expect(ctx.result.current.isEntering).toBe(true);

    act(() => vi.advanceTimersByTime(ENTRANCE_MS));
    expect(ctx.result.current.isEntering).toBe(false);
    ctx.cleanup();
  });

  it('reveals on the deadline when a gate never settles', () => {
    const ctx = setup(preparing);
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS));
    expect(ctx.result.current.isReady).toBe(true);
    ctx.cleanup();
  });

  it('keeps the deadline absolute when a gate settles mid-countdown', () => {
    const ctx = setup(preparing);
    act(() => vi.advanceTimersByTime(REVEAL_TIMEOUT_MS - 100));
    // Re-running the effect must not restart the countdown, or a canvas that
    // settles one gate late could stay covered for twice the deadline.
    ctx.rerender({ layoutSettled: true });
    expect(ctx.result.current.isReady).toBe(false);
    act(() => vi.advanceTimersByTime(100));
    expect(ctx.result.current.isReady).toBe(true);
    ctx.cleanup();
  });

  it('never shows the overlay for an empty canvas', () => {
    const ctx = setup({ hasContent: false, layoutSettled: false, viewSettled: false });
    expect(ctx.result.current.isReady).toBe(true);
    expect(ctx.result.current.showOverlay).toBe(false);
    expect(ctx.result.current.isEntering).toBe(false);
    ctx.cleanup();
  });
});
