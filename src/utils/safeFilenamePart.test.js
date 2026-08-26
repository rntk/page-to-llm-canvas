import { describe, it, expect } from 'vitest';
import { safeFilenamePart } from './safeFilenamePart.js';

describe('safeFilenamePart', () => {
  it('generates a safe filename part from arbitrary values', () => {
    expect(safeFilenamePart('page:one/two?three')).toBe('page-one-two-three');
    expect(safeFilenamePart('   ')).toBe('record');
    expect(safeFilenamePart(0)).toBe('record');
  });

  it('truncates long filename parts to 80 characters', () => {
    expect(safeFilenamePart('a'.repeat(200))).toHaveLength(80);
  });
});
