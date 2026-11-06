import { describe, expect, it } from 'vitest';
import {
  CARD_GAP,
  CARD_HEIGHT,
  CARD_WIDTH,
  MAX_ZOOM,
  MIN_ZOOM,
  clampZoom,
  gridColumns,
  layoutGrid,
  wheelZoomFactor,
  zoomViewport,
} from './canvasLayout.js';

describe('gridColumns', () => {
  it('uses ceil(sqrt(n)) columns', () => {
    expect([0, 1, 2, 4, 5, 9, 10].map(gridColumns)).toEqual([0, 1, 2, 2, 3, 3, 4]);
  });
});

describe('layoutGrid', () => {
  it('returns nothing for no ids', () => {
    expect(layoutGrid([])).toEqual({});
  });

  it('places cards row-major with the card size and gap', () => {
    const positions = layoutGrid([10, 11, 12, 13, 14]);
    const stepX = CARD_WIDTH + CARD_GAP;
    const stepY = CARD_HEIGHT + CARD_GAP;
    expect(positions[10]).toEqual({ x: 0, y: 0 });
    expect(positions[12]).toEqual({ x: 2 * stepX, y: 0 });
    expect(positions[13]).toEqual({ x: 0, y: stepY });
    expect(positions[14]).toEqual({ x: stepX, y: stepY });
  });
});

describe('clampZoom', () => {
  it('clamps to the allowed range and sanitizes non-finite values', () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
    expect(clampZoom(99)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
    expect(clampZoom(NaN)).toBe(1);
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
    const viewport = { x: 1, y: 2, zoom: MAX_ZOOM };
    expect(zoomViewport(viewport, 1.5, 5, 5)).toBe(viewport);
  });

  it('never exceeds the limits', () => {
    expect(zoomViewport({ x: 0, y: 0, zoom: 1 }, 100).zoom).toBe(MAX_ZOOM);
    expect(zoomViewport({ x: 0, y: 0, zoom: 1 }, 0.001).zoom).toBe(MIN_ZOOM);
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
