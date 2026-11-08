import { describe, it, expect } from 'vitest';
import { sortedUnique } from './sortedUnique.js';

describe('sortedUnique', () => {
  it('sorts numerically and drops duplicates', () => {
    expect(sortedUnique([10, 2, 2, 1, 10])).toEqual([1, 2, 10]);
  });

  it('accepts any iterable', () => {
    expect(sortedUnique(new Set([3, 1, 2]))).toEqual([1, 2, 3]);
    expect(sortedUnique(new Map([[5, 'a']]).keys())).toEqual([5]);
  });

  it('returns a new array for empty input', () => {
    expect(sortedUnique([])).toEqual([]);
  });
});
