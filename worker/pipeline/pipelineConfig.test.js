import { describe, expect, it } from 'vitest';
import {
  MAX_TAGGED_CHARS,
  SOURCE_SUMMARY_MAX_CHARS,
  getPipelineTextChunkMaxChars,
  getTopicRangeInputMaxSentences,
} from './pipelineConfig.js';
import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicRangesPrompt,
  buildTopicSummaryFromSourcePrompt,
} from './prompts.js';
import { PIPELINE_MIN_CONTEXT_WINDOW_TOKENS } from '../settings/contextWindowConstraints.js';

const CONSERVATIVE_CHARS_PER_TOKEN = 2;
const MINIMUM_TEXT_CHUNK_CHARS = 512;
const RESPONSE_RESERVED_TOKENS = 1024;

const FIXED_PIPELINE_PROMPTS = [
  ['topic ranges', buildTopicRangesPrompt],
  ['article summary', buildArticleSummaryPrompt],
  ['topic source summary', buildTopicSummaryFromSourcePrompt],
  ['article summary merge', buildArticleSummaryMergePrompt],
  ['leaf summary merge', buildLeafSummaryMergePrompt],
];

describe('pipeline request sizing', () => {
  it('keeps the persisted provider minimum stable', () => {
    expect(PIPELINE_MIN_CONTEXT_WINDOW_TOKENS).toBe(4096);
  });

  it('uses the shared conservative fallback when the context window is unknown', () => {
    expect(getPipelineTextChunkMaxChars(undefined)).toBe(MAX_TAGGED_CHARS);
    expect(getPipelineTextChunkMaxChars('invalid')).toBe(SOURCE_SUMMARY_MAX_CHARS);
  });

  it('shrinks the shared text budget for small-context providers and caps large ones', () => {
    expect(getPipelineTextChunkMaxChars(8192)).toBe(8192);
    expect(getPipelineTextChunkMaxChars(PIPELINE_MIN_CONTEXT_WINDOW_TOKENS)).toBeGreaterThanOrEqual(
      512,
    );
    expect(getPipelineTextChunkMaxChars(1_000_000)).toBe(MAX_TAGGED_CHARS);
  });

  it('scales topic marker counts to the available response budget', () => {
    expect(getTopicRangeInputMaxSentences(undefined)).toBe(240);
    expect(getTopicRangeInputMaxSentences(4096)).toBeLessThan(240);
    expect(getTopicRangeInputMaxSentences(8192)).toBeGreaterThan(
      getTopicRangeInputMaxSentences(4096),
    );
    expect(getTopicRangeInputMaxSentences(1_000_000)).toBe(240);
  });

  it('rejects windows below the stable provider minimum with an actionable error', () => {
    expect(() => getPipelineTextChunkMaxChars(1024)).toThrow(
      `"Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}`,
    );
  });

  it.each(FIXED_PIPELINE_PROMPTS)(
    '%s fixed prompt fits inside the stable minimum',
    (_, buildPrompt) => {
      const promptChars = buildPrompt('', {
        preferContentLanguage: true,
      }).length;
      const conservativePromptTokens = Math.ceil(promptChars / CONSERVATIVE_CHARS_PER_TOKEN);
      const minimumPayloadTokens = Math.ceil(
        MINIMUM_TEXT_CHUNK_CHARS / CONSERVATIVE_CHARS_PER_TOKEN,
      );

      expect(
        conservativePromptTokens + RESPONSE_RESERVED_TOKENS + minimumPayloadTokens,
      ).toBeLessThanOrEqual(PIPELINE_MIN_CONTEXT_WINDOW_TOKENS);
    },
  );
});
