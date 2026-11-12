import { describe, expect, it } from 'vitest';
import { horizontalWheelPan } from './canvasMath.js';

describe('horizontalWheelPan', () => {
  it('pans opposite to a sideways scroll', () => {
    expect(horizontalWheelPan({ deltaX: 30, deltaY: 2 })).toBe(-30);
    expect(horizontalWheelPan({ deltaX: -30, deltaY: 0 })).toBe(30);
  });

  it('leaves vertical-dominant, empty and pinch wheels to zoom', () => {
    expect(horizontalWheelPan({ deltaX: 5, deltaY: 40 })).toBe(0);
    expect(horizontalWheelPan({ deltaX: 0, deltaY: 0 })).toBe(0);
    expect(horizontalWheelPan({ deltaX: 50, deltaY: 0, ctrlKey: true })).toBe(0);
    expect(horizontalWheelPan({ deltaX: 50, deltaY: 0, metaKey: true })).toBe(0);
  });

  it('scales line and page deltas', () => {
    expect(horizontalWheelPan({ deltaX: 2, deltaY: 0, deltaMode: 1 })).toBe(-32);
    expect(horizontalWheelPan({ deltaX: 1, deltaY: 0, deltaMode: 2 }, 800)).toBe(-800);
  });
});
