import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildTopicRangesPrompt,
  buildArticleSummaryPrompt,
  buildArticleSummaryMergePrompt,
  buildLeafSummaryMergePrompt,
  buildTopicSummaryFromSourcePrompt,
  buildTaggedText,
  formatChunkSummariesForMerge,
  LANGUAGE_INSTRUCTION,
  ARTICLE_SUMMARY_PROMPT_TEMPLATE,
  ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE,
  LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE,
} from './prompts.js';
import { PROMPT_DELIMITER } from '../promptDelimiters.js';

describe('buildSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSystemPrompt();
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });

  it('contains hierarchy and assignment rules', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('HIERARCHY RULES');
    expect(prompt).toContain('ASSIGNMENT RULES');
  });

  it('contains security rules', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('SECURITY');
    expect(prompt).toContain('UNTRUSTED USER DATA');
  });
});

describe('buildTopicRangesPrompt', () => {
  it('includes the system prompt', () => {
    const prompt = buildTopicRangesPrompt('{0} hello');
    const systemPrompt = buildSystemPrompt();
    expect(prompt).toContain(systemPrompt);
  });

  it('includes the tagged text in content tags', () => {
    const tagged = '{0} hello world';
    const prompt = buildTopicRangesPrompt(tagged);
    expect(prompt).toContain(`<pagetollm_input>\n${tagged}\n</pagetollm_input>`);
  });

  it('includes output format instructions', () => {
    const prompt = buildTopicRangesPrompt('text');
    expect(prompt).toContain('OUTPUT FORMAT');
    expect(prompt).toContain('Broad Category>Subcategory>Specific Topic: marker ranges');
  });
});

describe('buildArticleSummaryPrompt', () => {
  it('replaces {text} placeholder with provided text', () => {
    const prompt = buildArticleSummaryPrompt('My article text');
    expect(prompt).toContain('My article text');
    expect(prompt).not.toContain('{text}');
  });

  it('instructs summaries to lead with substance', () => {
    const prompt = buildArticleSummaryPrompt('My article text');
    expect(prompt).toContain('Begin with the substance itself');
  });

  it('asks for a single concise sentence without bullets', () => {
    const prompt = buildArticleSummaryPrompt('My article text');
    expect(prompt).toContain('one concise sentence');
    expect(prompt).toContain('no bullets');
  });
});

describe('buildArticleSummaryMergePrompt', () => {
  it('replaces {chunk_summaries} placeholder', () => {
    const summaries = 'Chunk 1: summary one';
    const prompt = buildArticleSummaryMergePrompt(summaries);
    expect(prompt).toContain(summaries);
    expect(prompt).not.toContain('{chunk_summaries}');
  });

  it('instructs merged summaries to lead with substance', () => {
    const prompt = buildArticleSummaryMergePrompt('Chunk 1: summary one');
    expect(prompt).toContain('Begin with the substance itself');
  });
});

describe('prompt payload delimiters', () => {
  // Every prompt embeds exactly one payload block under the same delimiter, so
  // the Anthropic cache split (clients.js) always lands on the first occurrence
  // of the boundary marker. Prose may name the tag freely; only the payload
  // opener sits on its own line.
  it.each([
    ['topic ranges', '{0} payload', buildTopicRangesPrompt],
    ['article summary', 'payload', buildArticleSummaryPrompt],
    ['article merge', 'payload', buildArticleSummaryMergePrompt],
    ['leaf merge', 'payload', buildLeafSummaryMergePrompt],
    ['topic source', 'payload', buildTopicSummaryFromSourcePrompt],
  ])('the %s prompt opens exactly one payload block', (_name, payload, build) => {
    const prompt = build(payload);
    expect(prompt.split(PROMPT_DELIMITER.boundaryMarker)).toHaveLength(2);
    expect(prompt.trimEnd().endsWith(PROMPT_DELIMITER.close)).toBe(true);
    expect(prompt).toContain(PROMPT_DELIMITER.boundaryMarker + payload);
  });
});

describe('buildLeafSummaryMergePrompt', () => {
  it('keeps overflow leaf output to one sentence without bullets', () => {
    const prompt = buildLeafSummaryMergePrompt('Chunk 1: summary one');
    expect(prompt).toContain('Chunk 1: summary one');
    expect(prompt).toContain('single sentence, no bullets');
    expect(prompt).not.toContain('{chunk_summaries}');
  });
});

describe('buildTaggedText', () => {
  it('prefixes each sentence with {N}', () => {
    const result = buildTaggedText(['Hello.', 'World.']);
    expect(result).toBe('{0} Hello.\n{1} World.');
  });

  it('handles string sentences', () => {
    const result = buildTaggedText(['alpha', 'beta']);
    expect(result).toContain('{0} alpha');
    expect(result).toContain('{1} beta');
  });

  it('handles object sentences with .text property', () => {
    const result = buildTaggedText([{ text: 'alpha' }, { text: 'beta' }]);
    expect(result).toContain('{0} alpha');
    expect(result).toContain('{1} beta');
  });

  it('returns empty string for empty array', () => {
    expect(buildTaggedText([])).toBe('');
  });
});

describe('formatChunkSummariesForMerge', () => {
  it('formats each record with chunk number and sentence range', () => {
    const records = [
      { start_sentence: 0, end_sentence: 5, summary: { text: 'Chunk one summary.' } },
      { start_sentence: 6, end_sentence: 10, summary: { text: 'Chunk two summary.' } },
    ];
    const result = formatChunkSummariesForMerge(records);
    expect(result).toContain('Chunk 1 (sentences 0-5)');
    expect(result).toContain('Chunk one summary.');
    expect(result).toContain('Chunk 2 (sentences 6-10)');
    expect(result).toContain('Chunk two summary.');
  });

  it('handles missing summary gracefully', () => {
    const records = [{ start_sentence: 0, end_sentence: 3 }];
    const result = formatChunkSummariesForMerge(records);
    expect(result).toContain('Chunk 1 (sentences 0-3)');
  });
});

describe('preferContentLanguage option', () => {
  const builders = [
    ['buildTopicRangesPrompt', (opts) => buildTopicRangesPrompt('{0} hola', opts)],
    ['buildArticleSummaryPrompt', (opts) => buildArticleSummaryPrompt('texto', opts)],
    ['buildArticleSummaryMergePrompt', (opts) => buildArticleSummaryMergePrompt('resumen', opts)],
    [
      'buildTopicSummaryFromSourcePrompt',
      (opts) => buildTopicSummaryFromSourcePrompt('fuente', opts),
    ],
  ];

  for (const [name, build] of builders) {
    describe(name, () => {
      it('omits the language instruction by default', () => {
        expect(build(undefined)).not.toContain('LANGUAGE:');
        expect(build({})).not.toContain('LANGUAGE:');
        expect(build({ preferContentLanguage: false })).not.toContain('LANGUAGE:');
      });

      it('includes the language instruction when preferContentLanguage is true', () => {
        const prompt = build({ preferContentLanguage: true });
        expect(prompt).toContain('LANGUAGE:');
        expect(prompt).toContain('dominant language of the content');
      });

      it('carves out literal tokens so parsing/format stay intact', () => {
        const prompt = build({ preferContentLanguage: true });
        // The carve-out must protect the exact tokens downstream code matches.
        expect(prompt).toContain('NO_SUMMARY');
        expect(prompt).toContain('match the content language');
      });
    });
  }

  it('LANGUAGE_INSTRUCTION protects the NO_SUMMARY sentinel and marker IDs', () => {
    expect(LANGUAGE_INSTRUCTION).toContain('NO_SUMMARY');
    expect(LANGUAGE_INSTRUCTION).toContain('{0}');
  });

  it('preserves the strict topic-ranges content block when enabled', () => {
    const prompt = buildTopicRangesPrompt('{0} hola mundo', { preferContentLanguage: true });
    expect(prompt).toContain('<pagetollm_input>\n{0} hola mundo\n</pagetollm_input>');
    expect(prompt).toContain('OUTPUT FORMAT');
  });

  it('requires both category and lower-level labels in the content language', () => {
    const prompt = buildTopicRangesPrompt('{0} hola mundo', { preferContentLanguage: true });
    // The fix: the instruction must explicitly cover the top-level category, not
    // just the leaf tag, and neutralize the English example categories.
    expect(prompt).toContain('top-level category');
    expect(prompt).toContain('never emit English category names');
  });

  it('places the language block right before the content for topic ranges', () => {
    const prompt = buildTopicRangesPrompt('{0} hola', { preferContentLanguage: true });
    // Closest-to-generation placement beats the English example categories above.
    const languageIdx = prompt.indexOf('LANGUAGE:');
    const formatIdx = prompt.indexOf('OUTPUT FORMAT');
    // Locate the literal opening tag; prose references use only the quoted block name.
    const contentIdx = prompt.lastIndexOf('<pagetollm_input>');
    expect(formatIdx).toBeGreaterThanOrEqual(0);
    expect(languageIdx).toBeGreaterThan(formatIdx);
    expect(contentIdx).toBeGreaterThan(languageIdx);
  });
});

describe('prompt template constants', () => {
  it('ARTICLE_SUMMARY_PROMPT_TEMPLATE contains {text} placeholder', () => {
    expect(ARTICLE_SUMMARY_PROMPT_TEMPLATE).toContain('{text}');
  });

  it('ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE contains {chunk_summaries} placeholder', () => {
    expect(ARTICLE_SUMMARY_MERGE_PROMPT_TEMPLATE).toContain('{chunk_summaries}');
  });

  it('LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE contains {chunk_summaries} placeholder', () => {
    expect(LEAF_SUMMARY_MERGE_PROMPT_TEMPLATE).toContain('{chunk_summaries}');
  });
});
