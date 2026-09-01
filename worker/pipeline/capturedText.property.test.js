import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { normalizeCapturedTextKeepOffsets } from './capturedText.js';

describe('normalizeCapturedTextKeepOffsets properties', () => {
  it('always returns a monotonic in-bounds UTF-16 mapping with an end sentinel', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const result = normalizeCapturedTextKeepOffsets(input);
        expect(result.mapping).toHaveLength(result.text.length + 1);
        expect(result.mapping.at(-1)).toBe(input.length);
        for (let index = 1; index < result.mapping.length; index += 1) {
          expect(result.mapping[index]).toBeGreaterThanOrEqual(result.mapping[index - 1]);
          expect(result.mapping[index]).toBeLessThanOrEqual(input.length);
        }
      }),
    );
  });

  it('preserves strings that need no normalization', () => {
    const safeText = fc.string({
      unit: fc.constantFrom('a', 'b', 'Z', '0', '<', '>', '&', ';', '.', '-'),
    });
    fc.assert(
      fc.property(safeText, (input) => {
        const result = normalizeCapturedTextKeepOffsets(input);
        expect(result.text).toBe(input);
        expect(result.mapping).toEqual(
          Array.from({ length: input.length + 1 }, (_, index) => index),
        );
      }),
    );
  });
});
