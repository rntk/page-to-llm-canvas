import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { normalizeCapturedText } from './capturedText.js';

const zeroWidthChars = new Set(['\u200b', '\u200c', '\u200d', '\ufeff']);

function hasLongZeroWidthRun(str) {
  let count = 0;
  for (const ch of str) {
    if (zeroWidthChars.has(ch)) {
      count += 1;
      if (count >= 4) return true;
    } else {
      count = 0;
    }
  }
  return false;
}

function hasStrippableChar(str) {
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (
      code === 0x00ad ||
      code === 0x2060 ||
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0e && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f)
    ) {
      return true;
    }
  }
  return false;
}

describe('normalizeCapturedText properties', () => {
  it('satisfies normalization invariants for any input string', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeCapturedText(input);
        expect(typeof result).toBe('string');
        expect(result.length).toBeLessThanOrEqual(input.length);

        // No leading or trailing spaces
        expect(result.startsWith(' ')).toBe(false);
        expect(result.endsWith(' ')).toBe(false);

        // No consecutive spaces
        expect(result.includes('  ')).toBe(false);

        // No strippable control / format characters
        expect(hasStrippableChar(result)).toBe(false);

        // No suspicious long zero-width runs (4 or more)
        expect(hasLongZeroWidthRun(result)).toBe(false);

        // Idempotent: normalizing already-normalized text is a no-op
        expect(normalizeCapturedText(result)).toBe(result);
      }),
    );
  });

  it('preserves strings that need no normalization', () => {
    const safeText = fc.string({
      unit: fc.constantFrom('a', 'b', 'Z', '0', '<', '>', '&', ';', '.', '-'),
    });
    fc.assert(
      fc.property(safeText, (input) => {
        const result = normalizeCapturedText(input);
        expect(result).toBe(input);
      }),
    );
  });
});
