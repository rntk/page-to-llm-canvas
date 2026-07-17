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

const namedEntityArb = fc.constantFrom(
  { source: '&amp;', decoded: '&' },
  { source: '&AMP;', decoded: '&' },
  { source: '&lt;', decoded: '<' },
  { source: '&gt;', decoded: '>' },
  { source: '&quot;', decoded: '"' },
  { source: '&apos;', decoded: "'" },
  { source: '&nbsp;', decoded: '\u00a0' },
);

const numericEntityArb = fc
  .tuple(
    fc
      .integer({ min: 1, max: 0x10ffff })
      .filter((codePoint) => ![9, 10, 11, 12, 13, 32].includes(codePoint)),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([codePoint, hexadecimal, uppercaseX]) => ({
    source: hexadecimal
      ? `&#${uppercaseX ? 'X' : 'x'}${codePoint.toString(16)};`
      : `&#${codePoint};`,
    decoded: String.fromCodePoint(codePoint),
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
