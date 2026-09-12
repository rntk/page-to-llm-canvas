import { describe, expect, it } from 'vitest';
import { normalizeCapturedText } from './capturedText.js';

describe('normalizeCapturedText', () => {
  it('preserves literal markup-looking characters from captured DOM text', () => {
    const input = 'a <b> &amp; b';
    const result = normalizeCapturedText(input);
    expect(result).toBe(input);
  });

  it('normalizes whitespace and strips controls and suspicious zero-width runs', () => {
    const input = '  before\n\n\u0001\u200b\u200b\u200b\u200b after  ';
    const result = normalizeCapturedText(input);
    expect(result).toBe('before after');
  });

  it('preserves short shaping runs and valid subdivision-flag tag sequences', () => {
    const flag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e007f}';
    expect(normalizeCapturedText(`a\u200db`)).toBe('a\u200db');
    expect(normalizeCapturedText(`a${flag}b`)).toBe(`a${flag}b`);
  });

  it('removes Unicode Tags characters outside a subdivision flag', () => {
    expect(normalizeCapturedText('a\u{e0061}b')).toBe('ab');
  });
});
