import { describe, expect, it } from 'vitest';
import {
  MAX_TAGGED_CHARS,
  PIPELINE_FIXED_PROMPT_TOKENS,
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
import {
  estimateTokens,
  estimateTokensForCharCount,
  WORST_CASE_BYTES_PER_CODE_UNIT,
} from '../llm/tokenEstimator.js';

const MINIMUM_TEXT_CHUNK_CHARS = 512;
const RESPONSE_RESERVED_TOKENS = 1024;
const TOKENS_PER_SENTENCE = 32;

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
    expect(getPipelineTextChunkMaxChars(PIPELINE_MIN_CONTEXT_WINDOW_TOKENS)).toBe(663);
    expect(getPipelineTextChunkMaxChars(8192)).toBe(3723);
    expect(getPipelineTextChunkMaxChars(16384)).toBe(11170);
    expect(getPipelineTextChunkMaxChars(1_000_000)).toBe(MAX_TAGGED_CHARS);
  });

  it('scales topic marker counts to the available response budget', () => {
    expect(getTopicRangeInputMaxSentences(undefined)).toBe(240);
    expect(getTopicRangeInputMaxSentences(4096)).toBe(32);
    expect(getTopicRangeInputMaxSentences(8192)).toBe(54);
    expect(getTopicRangeInputMaxSentences(16384)).toBe(54);
    expect(getTopicRangeInputMaxSentences(1_000_000)).toBe(240);
    expect(getTopicRangeInputMaxSentences(8192)).toBeGreaterThan(getTopicRangeInputMaxSentences(4096));
  });

  it('rejects windows below the stable provider minimum with an actionable error', () => {
    expect(() => getPipelineTextChunkMaxChars(1024)).toThrow(
      `"Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}`,
    );
  });

  it.each(FIXED_PIPELINE_PROMPTS)(
    '%s fixed prompt fits inside the stable minimum',
    (_, buildPrompt) => {
      const prompt = buildPrompt('', { preferContentLanguage: true });
      const promptTokens = estimateTokens(prompt);
      const payloadTokens = estimateTokensForCharCount(MINIMUM_TEXT_CHUNK_CHARS, {
        bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
      });
      expect(promptTokens + RESPONSE_RESERVED_TOKENS + payloadTokens).toBeLessThanOrEqual(
        PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
      );
    },
  );

  it('does not overflow the window when topic markers and payload are worst-case', () => {
    for (const windowTokens of [4096, 8192, 16384]) {
      const maxChars = getPipelineTextChunkMaxChars(windowTokens);
      const sentenceCap = getTopicRangeInputMaxSentences(windowTokens);
      const payloadTokens = estimateTokensForCharCount(maxChars, {
        bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
      });
      const responseTokens = sentenceCap * TOKENS_PER_SENTENCE;
      expect(PIPELINE_FIXED_PROMPT_TOKENS + payloadTokens + responseTokens).toBeLessThanOrEqual(
        windowTokens,
      );
    }
  });
});
