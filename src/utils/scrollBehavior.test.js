import { describe, expect, it } from 'vitest';
import { scrollBehavior } from './scrollBehavior.js';

describe('scrollBehavior', () => {
  it('uses an instant scroll when reduced motion is preferred', () => {
    expect(scrollBehavior({ matchMedia: () => ({ matches: true }) })).toBe('instant');
    expect(scrollBehavior({ matchMedia: () => ({ matches: false }) })).toBe('smooth');
  });
});
