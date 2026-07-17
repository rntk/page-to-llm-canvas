import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  buildSystemPrompt,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  buildSentenceSummaryPrompt,
  formatChunkSummariesForMerge,
  buildTaggedText,
  LANGUAGE_INSTRUCTION,
  ARTICLE_SUMMARY_PROMPT_TEMPLATE,
  ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
  TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE,
  SENTENCE_SUMMARY_PROMPT_TEMPLATE,
} from './prompts.js';

const singleLineTextArb = fc.string().map((text) => text.replace(/[\r\n]/g, ' '));
const nonEmptySingleLineTextArb = fc
  .string({ minLength: 1 })
  .map((text) => text.replace(/[\r\n]/g, ' '));

function interpolateOnce(template, marker, value) {
  const markerIndex = template.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return `${template.slice(0, markerIndex)}${value}${template.slice(markerIndex + marker.length)}`;
}

function promptContentArb(marker, closingTag) {
  return fc.oneof(
    fc.string(),
    fc.constant(marker),
    fc.constant(`${marker} embedded in user content`),
    fc.constant(closingTag),
  );
}

describe('buildTaggedText properties', () => {
  it('emits exactly one marked output line per single-line sentence', () => {
    fc.assert(
      fc.property(fc.array(singleLineTextArb), (sentences) => {
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
      fc.property(fc.array(nonEmptySingleLineTextArb, { minLength: 1 }), (sentences) => {
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
    const a = buildSystemPrompt();
    const b = buildSystemPrompt();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });
});

describe('buildTopicRangesPrompt properties', () => {
  it('preserves arbitrary tagged content as the final content block', () => {
    fc.assert(
      fc.property(promptContentArb('{0}', '</content>'), (taggedText) => {
        const prompt = buildTopicRangesPrompt(taggedText);
        const languagePrompt = buildTopicRangesPrompt(taggedText, {
          preferContentLanguage: true,
        });
        const contentBlock = `<content>\n${taggedText}\n</content>\n`;
        const promptPrefix = prompt.slice(0, -contentBlock.length);
        expect(prompt.startsWith(buildSystemPrompt())).toBe(true);
        expect(prompt.endsWith(contentBlock)).toBe(true);
        expect(languagePrompt).toBe(`${promptPrefix}${LANGUAGE_INSTRUCTION}\n${contentBlock}`);
      }),
    );
  });
});

describe('buildArticleSummaryPrompt properties', () => {
  it('interpolates arbitrary content once without confusing content for a template token', () => {
    fc.assert(
      fc.property(
        promptContentArb('{text}', '</text>'),
        fc.boolean(),
        (text, preferContentLanguage) => {
          const prompt = buildArticleSummaryPrompt(text, { preferContentLanguage });
          const interpolated = interpolateOnce(ARTICLE_SUMMARY_PROMPT_TEMPLATE, '{text}', text);
          const expected = preferContentLanguage
            ? `${LANGUAGE_INSTRUCTION}\n${interpolated}`
            : interpolated;
          expect(prompt).toBe(expected);
        },
      ),
    );
  });
});

describe('buildArticleSummaryMergePrompt properties', () => {
  it('interpolates arbitrary chunk summaries exactly', () => {
    fc.assert(
      fc.property(
        promptContentArb('{chunk_summaries}', '</chunk_summaries>'),
        fc.boolean(),
        (summaries, preferContentLanguage) => {
          const prompt = buildArticleSummaryMergePrompt(summaries, { preferContentLanguage });
          const interpolated = interpolateOnce(
            ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
            '{chunk_summaries}',
            summaries,
          );
          const expected = preferContentLanguage
            ? `${LANGUAGE_INSTRUCTION}\n${interpolated}`
            : interpolated;
          expect(prompt).toBe(expected);
        },
      ),
    );
  });
});

describe('buildTopicSummaryFromSourcePrompt properties', () => {
  it('interpolates arbitrary source content exactly', () => {
    fc.assert(
      fc.property(
        promptContentArb('{source}', '</source>'),
        fc.boolean(),
        (source, preferContentLanguage) => {
          const prompt = buildTopicSummaryFromSourcePrompt(source, { preferContentLanguage });
          const interpolated = interpolateOnce(
            TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE,
            '{source}',
            source,
          );
          const expected = preferContentLanguage
            ? `${LANGUAGE_INSTRUCTION}\n${interpolated}`
            : interpolated;
          expect(prompt).toBe(expected);
        },
      ),
    );
  });
});

describe('buildSentenceSummaryPrompt properties', () => {
  it('interpolates arbitrary sentence content exactly', () => {
    fc.assert(
      fc.property(
        promptContentArb('{sentence}', '</text>'),
        fc.boolean(),
        (sentence, preferContentLanguage) => {
          const prompt = buildSentenceSummaryPrompt(sentence, { preferContentLanguage });
          const interpolated = interpolateOnce(
            SENTENCE_SUMMARY_PROMPT_TEMPLATE,
            '{sentence}',
            sentence,
          );
          const expected = preferContentLanguage
            ? `${LANGUAGE_INSTRUCTION}\n${interpolated}`
            : interpolated;
          expect(prompt).toBe(expected);
        },
      ),
    );
  });
});

describe('formatChunkSummariesForMerge properties', () => {
  const chunkRecordArb = fc.record({
    start_sentence: fc.nat(1000),
    end_sentence: fc.nat(1000),
    summary: fc.option(fc.record({ text: singleLineTextArb }), { nil: undefined }),
  });

  it('formats every generated chunk as an exact, separated block', () => {
    fc.assert(
      fc.property(fc.array(chunkRecordArb, { minLength: 1 }), (records) => {
        expect(formatChunkSummariesForMerge(records)).toBe(
          records
            .map(
              (record, index) =>
                `Chunk ${index + 1} (sentences ${record.start_sentence}-${record.end_sentence}):\n` +
                `${record.summary?.text || ''}`,
            )
            .join('\n\n'),
        );
      }),
    );
  });

  it('empty array produces empty string', () => {
    expect(formatChunkSummariesForMerge([])).toBe('');
  });
});
