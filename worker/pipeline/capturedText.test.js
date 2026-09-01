import { describe, expect, it } from 'vitest';
import { normalizeCapturedTextKeepOffsets } from './capturedText.js';

describe('normalizeCapturedTextKeepOffsets', () => {
  it('preserves literal markup-looking characters from captured DOM text', () => {
    const input = 'a <b> &amp; b';
    const result = normalizeCapturedTextKeepOffsets(input);
    expect(result.text).toBe(input);
    expect(result.mapping).toEqual(
      Array.from({ length: result.text.length }, (_, index) => index).concat(input.length),
    );
  });

  it('normalizes whitespace and strips controls and suspicious zero-width runs', () => {
    const input = '  before\n\n\u0001\u200b\u200b\u200b\u200b after  ';
    const result = normalizeCapturedTextKeepOffsets(input);
    expect(result.text).toBe('before after');
    expect(result.mapping.at(-1)).toBe(input.length);
    expect(result.mapping).toHaveLength(result.text.length + 1);
  });

  it('preserves short shaping runs and valid subdivision-flag tag sequences', () => {
    const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}';
    expect(normalizeCapturedTextKeepOffsets(`a\u200db`).text).toBe('a\u200db');
    expect(normalizeCapturedTextKeepOffsets(`a${flag}b`).text).toBe(`a${flag}b`);
  });

  it('removes Unicode Tags characters outside a subdivision flag', () => {
    expect(normalizeCapturedTextKeepOffsets('a\u{e0061}b').text).toBe('ab');
  });
});
