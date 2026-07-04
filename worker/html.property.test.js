import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { stripTagsKeepOffsets } from './html.js';

describe('stripTagsKeepOffsets properties', () => {
  it('always returns a string for text and a valid mapping array', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        expect(typeof result.text).toBe('string');
        expect(Array.isArray(result.mapping)).toBe(true);
        expect(result.mapping.length).toBe(result.text.length + 1);
      })
    );
  });

  it('mapping contains only valid offsets within original length', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        for (let i = 0; i < result.mapping.length; i++) {
          expect(result.mapping[i]).toBeGreaterThanOrEqual(0);
          expect(result.mapping[i]).toBeLessThanOrEqual(html.length);
        }
      })
    );
  });

  it('mapping is monotonically non-decreasing', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        for (let i = 1; i < result.mapping.length; i++) {
          expect(result.mapping[i]).toBeGreaterThanOrEqual(result.mapping[i - 1]);
        }
      })
    );
  });

  it('strips balanced tags and preserves surrounding text', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom('a', 'b', 'c', ' ', '1', '2') }),
        fc.string({ unit: fc.constantFrom('x', 'y', 'z', ' ', '3', '4') }),
        fc.string({ unit: fc.constantFrom('d', 'e', 'f', ' ', '5', '6') }),
        (before, inner, after) => {
          const html = `${before}<tag>${inner}</tag>${after}`;
          const result = stripTagsKeepOffsets(html);
          const normalize = (s) => s.replace(/\s+/g, ' ').trim();
          const normalized = normalize(result.text);
          // When surrounding text is non-empty after normalization, it should be preserved.
          if (normalize(before).length > 0) {
            expect(normalized).toContain(normalize(before));
          }
          if (normalize(inner).length > 0) {
            expect(normalized).toContain(normalize(inner));
          }
          if (normalize(after).length > 0) {
            expect(normalized).toContain(normalize(after));
          }
        },
      )
    );
  });

  it('always produces mapping where sentinel equals original length', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        const sentinel = result.mapping[result.mapping.length - 1];
        expect(sentinel).toBe(html.length);
      })
    );
  });

  it('plain text without tags preserves exact character mapping', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('a', 'b', 'c', 'd', 'e', ' ') }), (plain) => {
        const html = plain;
        const result = stripTagsKeepOffsets(html);
        // After whitespace collapse, mapping should still point to original chars.
        for (let i = 0; i < result.text.length; i++) {
          const origIdx = result.mapping[i];
          if (origIdx >= 0 && origIdx < html.length) {
            expect(html[origIdx]).toBe(result.text[i]);
          }
        }
      })
    );
  });
});
