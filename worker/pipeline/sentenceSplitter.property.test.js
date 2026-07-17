import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { splitSentences } from './sentenceSplitter.js';

const countWords = (s) => (s.match(/\S+/g) || []).length;

// Words made only of lowercase letters: no terminal punctuation, so no
// terminal-boundary splits — lets us isolate the anchoring/merging options.
const plainWordArb = fc.string({
  unit: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  minLength: 1,
  maxLength: 8,
});

const optsArb = fc.option(
  fc.record({
    anchorEveryWords: fc.integer({ min: 1, max: 100 }),
    longSentenceWordThreshold: fc.integer({ min: 1, max: 100 }),
    minSentenceWords: fc.integer({ min: 1, max: 100 }),
  }),
  { nil: undefined },
);

describe('splitSentences properties', () => {
  it('never throws and always returns valid, non-overlapping spans within bounds', () => {
    fc.assert(
      fc.property(fc.string(), optsArb, (text, opts) => {
        const result = splitSentences(text, opts);

        expect(Array.isArray(result)).toBe(true);

        let lastEnd = 0;
        for (const s of result) {
          // Check properties of each returned sentence
          expect(typeof s.text).toBe('string');
          expect(typeof s.start).toBe('number');
          expect(typeof s.end).toBe('number');

          // Bounds checks
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeLessThanOrEqual(text.length);
          expect(s.start).toBeLessThanOrEqual(s.end);

          // Reconstruct check
          expect(text.slice(s.start, s.end)).toBe(s.text);

          // Order & non-overlapping check
          expect(s.start).toBeGreaterThanOrEqual(lastEnd);
          lastEnd = s.end;
        }
      }),
    );
  });

  it('returns empty array for empty, whitespace, or null-like input', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\r') }), (wsOnly) => {
        expect(splitSentences(wsOnly)).toEqual([]);
      }),
    );
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences(null)).toEqual([]);
    expect(splitSentences(undefined)).toEqual([]);
  });

  it('preserves the exact sequence of non-whitespace tokens (no word deleted, altered, or reordered)', () => {
    fc.assert(
      fc.property(fc.string(), optsArb, (text, opts) => {
        const result = splitSentences(text, opts);
        const inputTokens = text.match(/\S+/g) || [];
        const outputTokens = result.flatMap((s) => s.text.match(/\S+/g) || []);
        // Concatenating the spans' tokens reconstructs the input's tokens exactly.
        expect(outputTokens).toEqual(inputTokens);
      }),
    );
  });

  it('longSentenceWordThreshold: input of <= threshold words with no terminal punctuation stays a single sentence', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 1, max: 30 }),
        fc.array(plainWordArb, { minLength: 1, maxLength: 40 }),
        (longSentenceWordThreshold, anchorEveryWords, minSentenceWords, words) => {
          fc.pre(words.length <= longSentenceWordThreshold);
          const text = words.join(' ');
          const result = splitSentences(text, {
            anchorEveryWords,
            longSentenceWordThreshold,
            minSentenceWords,
          });
          expect(result).toHaveLength(1);
          expect(result[0].text).toBe(text);
        },
      ),
    );
  });

  it('anchorEveryWords: with minSentenceWords=1 and no punctuation, non-final chunks have <= anchorEveryWords words and the final chunk <= longSentenceWordThreshold', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(plainWordArb, { minLength: 1, maxLength: 80 }),
        (longSentenceWordThreshold, anchorEveryWords, words) => {
          const text = words.join(' ');
          const result = splitSentences(text, {
            anchorEveryWords,
            longSentenceWordThreshold,
            minSentenceWords: 1,
          });
          for (let i = 0; i < result.length; i++) {
            const wc = countWords(result[i].text);
            const bound = i < result.length - 1 ? anchorEveryWords : longSentenceWordThreshold;
            expect(wc).toBeLessThanOrEqual(bound);
          }
        },
      ),
    );
  });

  it('minSentenceWords: whenever more than one sentence is returned, every sentence has at least minSentenceWords words', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 50 }),
        (text, anchorEveryWords, longSentenceWordThreshold, minSentenceWords) => {
          const result = splitSentences(text, {
            anchorEveryWords,
            longSentenceWordThreshold,
            minSentenceWords,
          });
          if (result.length <= 1) return;
          for (const s of result) {
            expect(countWords(s.text)).toBeGreaterThanOrEqual(minSentenceWords);
          }
        },
      ),
    );
  });

  it('terminal boundary followed by a sentence-start character splits into exactly two sentences when both sides are long enough', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(plainWordArb, { minLength: 5, maxLength: 10 }),
        fc.array(plainWordArb, { minLength: 5, maxLength: 10 }),
        (minSentenceWords, firstClause, secondClause) => {
          // Second clause words each start with an uppercase letter so the
          // char after the boundary satisfies the sentence-start regex.
          const first = firstClause.join(' ');
          const second = secondClause.map((w) => `A${w}`).join(' ');
          const text = `${first}. ${second}`;
          const result = splitSentences(text, {
            minSentenceWords,
            longSentenceWordThreshold: 100,
            anchorEveryWords: 100,
          });
          expect(result).toHaveLength(2);
          expect(result[0].text).toBe(`${first}.`);
          expect(result[1].text).toBe(second);
        },
      ),
    );
  });
});
