import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildSystemPrompt,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildSentenceSummaryPrompt,
  formatChunkSummariesForMerge,
  buildTaggedText,
} from './prompts.js';

describe('buildTaggedText properties', () => {
  it('output always contains the same number of lines as input sentences', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (sentences) => {
        const result = buildTaggedText(sentences);
        if (sentences.length === 0) {
          expect(result).toBe('');
        } else {
          const lines = result.split('\n');
          expect(lines.length).toBe(sentences.length);
        }
      }),
    );
  });

  it('each line starts with {N} marker where N is the index', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 }), { minLength: 1 }), (sentences) => {
        const result = buildTaggedText(sentences);
        const lines = result.split('\n');
        expect(lines.length).toBe(sentences.length);
        for (let i = 0; i < lines.length; i++) {
          expect(lines[i]).toMatch(new RegExp(`^\\{${i}\\} `));
        }
      }),
    );
  });

  it('handles object sentences with text property identically to strings', () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (sentences) => {
        const stringResult = buildTaggedText(sentences);
        const objectResult = buildTaggedText(sentences.map((s) => ({ text: s })));
        expect(objectResult).toBe(stringResult);
      }),
    );
  });
});

describe('buildSystemPrompt properties', () => {
  it('always returns the same stable string', () => {
    fc.assert(
      fc.property(fc.nat(10), () => {
        const a = buildSystemPrompt();
        const b = buildSystemPrompt();
        expect(a).toBe(b);
        expect(a.length).toBeGreaterThan(0);
      }),
    );
  });
});

describe('buildTopicRangesPrompt properties', () => {
  it('always includes the system prompt and the tagged text', () => {
    fc.assert(
      fc.property(fc.string(), (taggedText) => {
        const prompt = buildTopicRangesPrompt(taggedText);
        expect(prompt).toContain(buildSystemPrompt());
        expect(prompt).toContain(taggedText);
        expect(prompt).toContain('<content>');
        expect(prompt).toContain('</content>');
      }),
    );
  });
});

describe('buildArticleSummaryPrompt properties', () => {
  it('always replaces the {text} placeholder', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const prompt = buildArticleSummaryPrompt(text);
        expect(prompt).not.toContain('{text}');
        // Template wraps text inside <text> tags, so verify presence there.
        expect(prompt).toContain(`<text>${text}</text>`);
      }),
    );
  });
});

describe('buildArticleSummaryMergePrompt properties', () => {
  it('always replaces the {chunk_summaries} placeholder', () => {
    fc.assert(
      fc.property(fc.string(), (summaries) => {
        const prompt = buildArticleSummaryMergePrompt(summaries);
        expect(prompt).not.toContain('{chunk_summaries}');
        expect(prompt).toContain(`<chunk_summaries>${summaries}</chunk_summaries>`);
      }),
    );
  });
});

describe('buildSentenceSummaryPrompt properties', () => {
  it('always replaces the {sentence} placeholder', () => {
    fc.assert(
      fc.property(fc.string(), (sentence) => {
        const prompt = buildSentenceSummaryPrompt(sentence);
        expect(prompt).not.toContain('{sentence}');
        expect(prompt).toContain(`<text>${sentence}</text>`);
      }),
    );
  });
});

describe('formatChunkSummariesForMerge properties', () => {
  it('output contains chunk numbers for every record', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start_sentence: fc.nat(1000),
            end_sentence: fc.nat(1000),
            summary: fc.option(fc.record({ text: fc.string() }), { nil: undefined }),
          }),
        ),
        (records) => {
          const result = formatChunkSummariesForMerge(records);
          for (let i = 0; i < records.length; i++) {
            expect(result).toContain(`Chunk ${i + 1}`);
          }
        },
      ),
    );
  });

  it('empty array produces empty string', () => {
    expect(formatChunkSummariesForMerge([])).toBe('');
  });

  it('output length grows monotonically with record count', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start_sentence: fc.nat(100),
            end_sentence: fc.nat(100),
            summary: fc.option(fc.record({ text: fc.string() }), { nil: undefined }),
          }),
          { minLength: 1 },
        ),
        (records) => {
          const full = formatChunkSummariesForMerge(records);
          const truncated = formatChunkSummariesForMerge(records.slice(0, -1));
          expect(full.length).toBeGreaterThan(truncated.length);
        },
      ),
    );
  });
});
