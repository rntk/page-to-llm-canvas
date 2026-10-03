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
  SUMMARY_LANGUAGE_INSTRUCTION,
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

// The summary language block sits on its own paragraph right before the
// payload label line ("Text:", "Source:", "Chunk summaries:").
function withSummaryLanguage(interpolated) {
  const labelStart = interpolated.lastIndexOf('\n\n', interpolated.indexOf('\n<pagetollm_input>\n')) + 2;
  return `${interpolated.slice(0, labelStart)}${SUMMARY_LANGUAGE_INSTRUCTION}\n${interpolated.slice(labelStart)}`;
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
      summaryLanguage: sha256(currentPrompts.SUMMARY_LANGUAGE_INSTRUCTION),
      articleSummary: sha256(currentPrompts.ARTICLE_SUMMARY_PROMPT_TEMPLATE),
      articleMerge: sha256(currentPrompts.ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE),
      leafMerge: sha256(currentPrompts.LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE),
      topicSource: sha256(currentPrompts.TOPIC_SOURCE_SUMMARY_PROMPT_TEMPLATE),
    }).toEqual({
      system: 'fe8d4dff9bffeaf618865195b761a060c4d87c62198f3907d994cc11cd39057a',
      language: 'c5e749798d193785ff6c649ebcd2279f46532a21d5a1ec6fc9a0f142367c6425',
      summaryLanguage: 'c20569562d3aae8c28ecf50004b221e3604983576d612d443f29ca419cd4ec62',
      articleSummary: '5474b73cb0f2cbcd51e19f31a804e5b299155b684b6b5f23b963ccba82392231',
      articleMerge: '87f55592ff5bec9a1a8a39db6d9dd08dd190b6a4964b2de6ea4c36423b02a467',
      leafMerge: '875464fb3cfe43d1097396f964c73b107e85133080824e70ad15a757a9bcc50d',
      topicSource: '51f4519076f1679bc7c0a05769986b4ea0e7725e5b024454c54e645addbd0727',
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
            ? withSummaryLanguage(interpolated)
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
