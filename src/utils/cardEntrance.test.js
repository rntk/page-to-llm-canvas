import { describe, it, expect } from 'vitest';
import { getCardEnterDelay, STAGGER_WINDOW_MS, MAX_STAGGER_STEP_MS } from './cardEntrance.js';

describe('getCardEnterDelay', () => {
  it('has no delay for the first card, or a lone card', () => {
    expect(getCardEnterDelay(0, 40)).toBe(0);
    expect(getCardEnterDelay(0, 1)).toBe(0);
    expect(getCardEnterDelay(3, 0)).toBe(0);
  });

  it('uses the full step while the column is short', () => {
    expect(getCardEnterDelay(1, 5)).toBe(MAX_STAGGER_STEP_MS);
    expect(getCardEnterDelay(4, 5)).toBe(4 * MAX_STAGGER_STEP_MS);
  });

  it('keeps a long column inside the stagger window', () => {
    // The whole point: 200 topic cards must not dribble in over three seconds.
    const last = getCardEnterDelay(199, 200);
    expect(last).toBeLessThanOrEqual(STAGGER_WINDOW_MS);
    expect(getCardEnterDelay(150, 200)).toBeLessThan(last);
  });
});
