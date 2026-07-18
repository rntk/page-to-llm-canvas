import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { stripTagsKeepOffsets } from './html.js';

const HTML_WHITESPACE_RE = /[ \t\n\r\f\v]+/g;
const normalizeHtmlText = (text) => text.replace(HTML_WHITESPACE_RE, ' ').trim();

const asciiTextArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'X', 'Y', 'Z', '0', '1', ' ', '\t', '\n'),
  maxLength: 30,
});

// No whitespace or markup characters: this lets the entity property assert
// every output offset exactly, rather than merely checking broad bounds.
const safeTokenArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'X', 'Y', 'Z', '0', '1'),
  maxLength: 20,
});

const LEGACY_C1_REPLACEMENTS = new Map([
  [0x80, 0x20ac],
  [0x82, 0x201a],
  [0x83, 0x0192],
  [0x84, 0x201e],
  [0x85, 0x2026],
  [0x86, 0x2020],
  [0x87, 0x2021],
  [0x88, 0x02c6],
  [0x89, 0x2030],
  [0x8a, 0x0160],
  [0x8b, 0x2039],
  [0x8c, 0x0152],
  [0x8e, 0x017d],
  [0x91, 0x2018],
  [0x92, 0x2019],
  [0x93, 0x201c],
  [0x94, 0x201d],
  [0x95, 0x2022],
  [0x96, 0x2013],
  [0x97, 0x2014],
  [0x98, 0x02dc],
  [0x99, 0x2122],
  [0x9a, 0x0161],
  [0x9b, 0x203a],
  [0x9c, 0x0153],
  [0x9e, 0x017e],
  [0x9f, 0x0178],
]);

const decodedNumericCodePoint = (codePoint) => LEGACY_C1_REPLACEMENTS.get(codePoint) ?? codePoint;

const namedEntityArb = fc.constantFrom(
  { source: '&amp;', decoded: '&' },
  { source: '&AMP;', decoded: '&' },
  { source: '&lt;', decoded: '<' },
  { source: '&gt;', decoded: '>' },
  { source: '&quot;', decoded: '"' },
  { source: '&apos;', decoded: "'" },
  // &nbsp; decodes to NBSP (U+00A0), which is now treated as a
  // whitespace-equivalent character by stripTagsKeepOffsets (it collapses
  // to a single space, or is suppressed entirely as leading/trailing
  // whitespace). It is therefore not emitted verbatim like the other named
  // entities here, so it is excluded from this exact-offset property test
  // (mirroring the numericEntityArb exclusions above).
);

// Codepoints whose decoded output is no longer emitted verbatim as a single
// character by stripTagsKeepOffsets: whitespace-equivalent characters
// (collapsed to a single space) and characters that are stripped entirely.
const isCollapsedOrStrippedCodePoint = (codePoint) => {
  const isWhitespaceEquivalent =
    codePoint === 9 ||
    codePoint === 10 ||
    codePoint === 11 ||
    codePoint === 12 ||
    codePoint === 13 ||
    codePoint === 32 ||
    codePoint === 0x85 ||
    codePoint === 0xa0 ||
    codePoint === 0x1680 ||
    (codePoint >= 0x2000 && codePoint <= 0x200a) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    codePoint === 0x202f ||
    codePoint === 0x205f ||
    codePoint === 0x3000;
  const isStripped =
    codePoint === 0xad ||
    codePoint === 0x2060 ||
    (codePoint >= 0x00 && codePoint <= 0x08) ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xe0000 && codePoint <= 0xe007f);
  return isWhitespaceEquivalent || isStripped;
};

const numericEntityArb = fc
  .tuple(
    fc
      .integer({ min: 1, max: 0x10ffff })
      .filter((codePoint) => !isCollapsedOrStrippedCodePoint(decodedNumericCodePoint(codePoint))),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([codePoint, hexadecimal, uppercaseX]) => ({
    source: hexadecimal
      ? `&#${uppercaseX ? 'X' : 'x'}${codePoint.toString(16)};`
      : `&#${codePoint};`,
    decoded: String.fromCodePoint(decodedNumericCodePoint(codePoint)),
  }));

const entityArb = fc.oneof(namedEntityArb, numericEntityArb);

describe('stripTagsKeepOffsets properties', () => {
  it('always returns a string for text and a valid mapping array', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        expect(typeof result.text).toBe('string');
        expect(Array.isArray(result.mapping)).toBe(true);
        expect(result.mapping.length).toBe(result.text.length + 1);
      }),
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
      }),
    );
  });

  it('mapping is monotonically non-decreasing', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        for (let i = 1; i < result.mapping.length; i++) {
          expect(result.mapping[i]).toBeGreaterThanOrEqual(result.mapping[i - 1]);
        }
      }),
    );
  });

  it('strips generated balanced tags and normalizes their boundaries exactly', () => {
    fc.assert(
      fc.property(
        asciiTextArb,
        asciiTextArb,
        asciiTextArb,
        fc.constantFrom('div', 'span', 'article', 'custom-element'),
        (before, inner, after, tagName) => {
          const html = `${before}<${tagName} data-kind="generated">${inner}</${tagName}>${after}`;
          const result = stripTagsKeepOffsets(html);
          expect(result.text).toBe(normalizeHtmlText(`${before} ${inner} ${after}`));
        },
      ),
    );
  });

  it('removes generated script and style blocks, including delimiter variants', () => {
    fc.assert(
      fc.property(
        asciiTextArb,
        asciiTextArb,
        asciiTextArb,
        fc.constantFrom('script', 'style'),
        fc.constantFrom('>', ' data-kind="generated">', '\tdata-kind="generated">', '\n>'),
        fc.boolean(),
        (before, ignored, after, tagName, openingEnd, uppercase) => {
          const renderedName = uppercase ? tagName.toUpperCase() : tagName;
          const html = `${before}<${renderedName}${openingEnd}${ignored}</${renderedName}>${after}`;
          const result = stripTagsKeepOffsets(html);
          expect(result.text).toBe(normalizeHtmlText(`${before} ${after}`));
        },
      ),
    );
  });

  it('decodes generated entities with exact UTF-16 offset mappings', () => {
    fc.assert(
      fc.property(safeTokenArb, entityArb, safeTokenArb, (before, entity, after) => {
        const html = `${before}${entity.source}${after}`;
        const result = stripTagsKeepOffsets(html);
        const entityOffset = before.length;
        const afterOffset = entityOffset + entity.source.length;

        expect(result.text).toBe(`${before}${entity.decoded}${after}`);
        expect(result.mapping).toEqual([
          ...Array.from({ length: before.length }, (_, index) => index),
          ...Array(entity.decoded.length).fill(entityOffset),
          ...Array.from({ length: after.length }, (_, index) => afterOffset + index),
          html.length,
        ]);
      }),
    );
  });

  it('maps both UTF-16 code units of a decoded non-BMP entity', () => {
    for (const html of ['&#x1F600;', '&#128512;']) {
      expect(stripTagsKeepOffsets(html)).toEqual({
        text: '😀',
        mapping: [0, 0, html.length],
      });
    }
  });

  it('always produces mapping where sentinel equals original length', () => {
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = stripTagsKeepOffsets(html);
        const sentinel = result.mapping[result.mapping.length - 1];
        expect(sentinel).toBe(html.length);
      }),
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
      }),
    );
  });
});
