import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE } from '../utils/canvasMath.js';
import { gridColumns, wheelZoomFactor, zoomViewport } from './canvasLayout.js';

describe('gridColumns', () => {
  it('uses ceil(sqrt(n)) columns', () => {
    expect([0, 1, 2, 4, 5, 9, 10].map(gridColumns)).toEqual([0, 1, 2, 2, 3, 3, 4]);
  });
});

describe('zoomViewport', () => {
  it('keeps the origin point fixed on screen', () => {
    const next = zoomViewport({ x: 10, y: 20, zoom: 1 }, 2, 100, 100);
    expect(next.zoom).toBe(2);
    // surface point under the origin before and after
    expect((100 - 10) / 1).toBeCloseTo((100 - next.x) / next.zoom);
    expect((100 - 20) / 1).toBeCloseTo((100 - next.y) / next.zoom);
  });

  it('returns the same viewport when already at the limit', () => {
    const viewport = { x: 1, y: 2, zoom: MAX_SCALE };
    expect(zoomViewport(viewport, 1.5, 5, 5)).toBe(viewport);
  });

  it('never exceeds the limits', () => {
    expect(zoomViewport({ x: 0, y: 0, zoom: 1 }, 100).zoom).toBe(MAX_SCALE);
    expect(zoomViewport({ x: 0, y: 0, zoom: 1 }, 0.001).zoom).toBe(MIN_SCALE);
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in on negative delta and out on positive delta', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('normalizes line and page deltas into pixels', () => {
    expect(wheelZoomFactor(3, 1, 500)).toBeCloseTo(wheelZoomFactor(48));
    expect(wheelZoomFactor(0.25, 2, 400)).toBeCloseTo(wheelZoomFactor(100));
  });

  it('bounds the effect of extreme wheel deltas', () => {
    expect(wheelZoomFactor(10000)).toBe(wheelZoomFactor(240));
    expect(wheelZoomFactor(-10000)).toBe(wheelZoomFactor(-240));
  });
});
