import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { createHash } from 'node:crypto';
import {
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildLeafSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  formatChunkSummariesForMerge,
  LANGUAGE_INSTRUCTION,
  ARTICLE_SUMMARY_PROMPT_TEMPLATE,
  ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
  LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE,
  TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE,
} from './prompts.js';

const singleLineTextArb = fc.string().map((text) => text.replace(/[\r\n]/g, ' '));

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

function systemPromptFromRangePrompt(prompt) {
  return prompt.slice(0, prompt.indexOf('\n\nOUTPUT FORMAT:'));
}

describe('prompt contract fingerprints', () => {
  const sha256 = (value) => createHash('sha256').update(value).digest('hex');

  it('keeps the reviewed prompt instructions byte-for-byte stable', async () => {
    vi.resetModules();
    const currentPrompts = await import('./prompts.js');
    expect({
      system: sha256(systemPromptFromRangePrompt(currentPrompts.buildTopicRangesPrompt(''))),
      language: sha256(currentPrompts.LANGUAGE_INSTRUCTION),
      articleSummary: sha256(currentPrompts.ARTICLE_SUMMARY_PROMPT_TEMPLATE),
      articleMerge: sha256(currentPrompts.ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE),
      leafMerge: sha256(currentPrompts.LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE),
      topicSource: sha256(currentPrompts.TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE),
    }).toEqual({
      system: 'ce93e60e740ccefbf1f8d97b1d943a454a7c638e5475bc245d9ca56875b96c78',
      language: 'e9c6cdd8dedb466e5cd5277b1ef73530747d1afaad1987b880f97fae790e9d5b',
      articleSummary: '78a69fb1fa2d4f65dac38a56d59c6f4c69fbfc733e28fd81b0394a0cdb2e0270',
      articleMerge: 'a9fb4e06cb44c2dba5d81f75730a922395d4994ef63557055cdb35e1a18df568',
      leafMerge: 'f5452ed341bd821f6c2e35e21d4790ebb33ba3c4e2f8273f44088be6ad5a5603',
      topicSource: 'a8a17a2f95f6ecb70364d99fcf55b49cb134fe824b09c40e9353268759180de1',
    });
  });
});

describe('buildTopicRangesPrompt properties', () => {
  it('preserves arbitrary tagged content as the final content block', () => {
    fc.assert(
      fc.property(promptContentArb('{0}', '</pagetollm_input>'), (taggedText) => {
        const prompt = buildTopicRangesPrompt(taggedText);
        const languagePrompt = buildTopicRangesPrompt(taggedText, {
          preferContentLanguage: true,
        });
        const contentBlock = `<pagetollm_input>\n${taggedText}\n</pagetollm_input>\n`;
        const promptPrefix = prompt.slice(0, -contentBlock.length);
        expect(prompt.startsWith(systemPromptFromRangePrompt(buildTopicRangesPrompt('')))).toBe(
          true,
        );
        expect(prompt.endsWith(contentBlock)).toBe(true);
        expect(languagePrompt).toBe(`${promptPrefix}${LANGUAGE_INSTRUCTION}\n${contentBlock}`);
      }),
    );
  });
});

const interpolatingBuilders = [
  [
    'buildArticleSummaryPrompt',
    buildArticleSummaryPrompt,
    ARTICLE_SUMMARY_PROMPT_TEMPLATE,
    '{text}',
  ],
  [
    'buildArticleSummaryMergePrompt',
    buildArticleSummaryMergePrompt,
    ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
    '{chunk_summaries}',
  ],
  [
    'buildLeafSummaryMergePrompt',
    buildLeafSummaryMergePrompt,
    LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE,
    '{chunk_summaries}',
  ],
  [
    'buildTopicSummaryFromSourcePrompt',
    buildTopicSummaryFromSourcePrompt,
    TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE,
    '{source}',
  ],
];

describe.each(interpolatingBuilders)('%s properties', (_name, build, template, marker) => {
  it('does not add a language instruction when options are omitted', () => {
    expect(build('Chunk 1 summary')).toBe(interpolateOnce(template, marker, 'Chunk 1 summary'));
  });

  it('interpolates arbitrary content once without confusing content for a template token', () => {
    fc.assert(
      fc.property(
        promptContentArb(marker, '</pagetollm_input>'),
        fc.boolean(),
        (content, preferContentLanguage) => {
          const interpolated = interpolateOnce(template, marker, content);
          const expected = preferContentLanguage
            ? `${LANGUAGE_INSTRUCTION}\n${interpolated}`
            : interpolated;
          expect(build(content, { preferContentLanguage })).toBe(expected);
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
