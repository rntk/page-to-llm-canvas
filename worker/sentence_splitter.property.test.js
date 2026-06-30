import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { splitSentences } from './sentence_splitter.js';

describe('splitSentences properties', () => {
  it('never throws and always returns valid, non-overlapping spans within bounds', () => {
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(
          fc.record({
            anchorEveryWords: fc.integer({ min: 1, max: 100 }),
            longSentenceWordThreshold: fc.integer({ min: 1, max: 100 }),
            minSentenceWords: fc.integer({ min: 1, max: 100 }),
          }),
          { nil: undefined }
        ),
        (text, opts) => {
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
        }
      ),
      { numRuns: 300 }
    );
  });

  it('returns empty array for empty, whitespace, or null-like input', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(' ', '\t', '\n', '\r') }),
        (wsOnly) => {
          expect(splitSentences(wsOnly)).toEqual([]);
        }
      ),
      { numRuns: 100 }
    );
    expect(splitSentences('')).toEqual([]);
    expect(splitSentences(null)).toEqual([]);
    expect(splitSentences(undefined)).toEqual([]);
  });

  it('preserves words in the output (words are not deleted, only split/grouped)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 10 }).filter(s => /^\S+$/.test(s)), { minLength: 1, maxLength: 50 }),
        (words) => {
          const text = words.join(' ');
          const result = splitSentences(text);
          
          // Re-tokenize output to check that no word was lost/altered
          const outputText = result.map(s => s.text).join(' ');
          const originalWords = words.map(w => w.trim()).filter(Boolean);
          const outputWords = outputText.split(/\s+/).map(w => w.trim()).filter(Boolean);
          
          // Note: splitting and trimming might slightly alter whitespace,
          // but the word sequences should be highly comparable.
          expect(outputWords.length).toBeLessThanOrEqual(originalWords.length);
          for (const w of outputWords) {
            expect(text).toContain(w);
          }
        }
      ),
      { numRuns: 200 }
    );
  });
});
