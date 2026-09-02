import { describe, expect, it } from 'vitest';
import { splitTextToMaxChars } from './textChunking.js';

describe('splitTextToMaxChars', () => {
  it('prefers useful word boundaries and bounds every part', () => {
    const parts = splitTextToMaxChars('alpha beta gamma delta', 11);

    expect(parts).toEqual(['alpha beta', 'gamma delta']);
    expect(parts.every((part) => part.length <= 11)).toBe(true);
  });

  it('can preserve whitespace exactly for lossless consumers', () => {
    const source = 'alpha  beta gamma';
    const parts = splitTextToMaxChars(source, 8, { preserveWhitespace: true });

    expect(parts.join('')).toBe(source);
    expect(parts.every((part) => part.length <= 8)).toBe(true);
  });

  it('hard-splits text without a useful boundary', () => {
    expect(splitTextToMaxChars('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('rejects a non-positive or non-finite limit', () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => splitTextToMaxChars('text', limit)).toThrow('maxChars must be positive');
    }
  });
});
