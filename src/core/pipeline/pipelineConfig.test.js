import { describe, expect, it } from 'vitest';
import {
  MAX_TAGGED_CHARS,
  PIPELINE_FIXED_PROMPT_TOKENS,
  PIPELINE_TEXT_CHUNK_MAX_CHARS,
  SOURCE_SUMMARY_MAX_CHARS,
  TOPIC_RANGE_INPUT_MAX_SENTENCES,
  getArticleChatLimits,
  getPipelineTextChunkMaxChars,
  getResplitTextChunkMaxChars,
  getTopicRangeInputMaxSentences,
} from './pipelineConfig.js';
import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicRangesPrompt,
  buildTopicSummaryFromSourcePrompt,
} from './prompts.js';
import {
  ARTICLE_CHAT_MAX_CHUNK_CHARS,
  ARTICLE_CHAT_MAX_HISTORY_CHARS,
  PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
} from '../settings/llmBudgets.js';
import {
  estimateTokens,
  estimateTokensForCharCount,
  WORST_CASE_BYTES_PER_CODE_UNIT,
} from '../llm/tokenEstimator.js';

const RESPONSE_RESERVED_TOKENS = 1024;
const TOKENS_PER_SENTENCE = 32;
const SMALL_CONTEXT = PIPELINE_MIN_CONTEXT_WINDOW_TOKENS;
const MEDIUM_CONTEXT = SMALL_CONTEXT * 2;
const LARGE_CONTEXT = SMALL_CONTEXT * 4;
const OVERSIZED_CONTEXT = Number.MAX_SAFE_INTEGER;

const FIXED_PIPELINE_PROMPTS = [
  ['topic ranges', buildTopicRangesPrompt],
  [
    'topic ranges resplit',
    (text, options) =>
      buildTopicRangesPrompt(text, {
        ...options,
        resplitParentPath: 'Technology>Artificial Intelligence>Language Models>Prompt Caching',
      }),
  ],
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
    const small = getPipelineTextChunkMaxChars(SMALL_CONTEXT);
    const medium = getPipelineTextChunkMaxChars(MEDIUM_CONTEXT);
    const large = getPipelineTextChunkMaxChars(LARGE_CONTEXT);
    expect(small).toBeGreaterThan(0);
    expect(small).toBe(449);
    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    expect(medium).toBe(3723);
    expect(large).toBe(11170);
    expect(getPipelineTextChunkMaxChars(OVERSIZED_CONTEXT)).toBe(MAX_TAGGED_CHARS);
  });

  it('scales topic marker counts to the available response budget', () => {
    expect(getTopicRangeInputMaxSentences(undefined)).toBe(TOPIC_RANGE_INPUT_MAX_SENTENCES);
    const small = getTopicRangeInputMaxSentences(SMALL_CONTEXT);
    const medium = getTopicRangeInputMaxSentences(MEDIUM_CONTEXT);
    expect(small).toBeGreaterThan(0);
    expect(small).toBe(32);
    expect(medium).toBe(47);
    expect(medium).toBeGreaterThan(small);
    expect(medium).toBeLessThanOrEqual(TOPIC_RANGE_INPUT_MAX_SENTENCES);
    expect(getTopicRangeInputMaxSentences(OVERSIZED_CONTEXT)).toBe(TOPIC_RANGE_INPUT_MAX_SENTENCES);
  });

  it('rejects windows below the stable provider minimum with an actionable error', () => {
    expect(() => getPipelineTextChunkMaxChars(SMALL_CONTEXT / 4)).toThrow(
      `"Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}`,
    );
  });

  it.each(FIXED_PIPELINE_PROMPTS)(
    '%s fixed prompt fits inside the stable minimum',
    (_, buildPrompt) => {
      const prompt = buildPrompt('', { preferContentLanguage: true });
      const promptTokens = estimateTokens(prompt);
      const payloadTokens = estimateTokensForCharCount(
        getPipelineTextChunkMaxChars(SMALL_CONTEXT),
        {
          bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
        },
      );
      expect(promptTokens + RESPONSE_RESERVED_TOKENS + payloadTokens).toBeLessThanOrEqual(
        PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
      );
    },
  );

  it.each(FIXED_PIPELINE_PROMPTS)('%s is included in fixed prompt overhead', (_, buildPrompt) => {
    expect(PIPELINE_FIXED_PROMPT_TOKENS).toBeGreaterThanOrEqual(
      estimateTokens(buildPrompt('', { preferContentLanguage: true })),
    );
  });

  it('does not overflow the window when topic markers and payload are worst-case', () => {
    for (const windowTokens of [SMALL_CONTEXT, MEDIUM_CONTEXT, LARGE_CONTEXT]) {
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

  it('charges long ASCII and CJK resplit paths to the payload budget', () => {
    const baseMaxChars = getPipelineTextChunkMaxChars(SMALL_CONTEXT);
    const responseTokens = getTopicRangeInputMaxSentences(SMALL_CONTEXT) * TOKENS_PER_SENTENCE;
    for (const parentPath of ['Technology>' + 'Long topic '.repeat(30), '研究'.repeat(180)]) {
      const maxChars = getResplitTextChunkMaxChars(baseMaxChars, parentPath, true);
      expect(maxChars).toBeGreaterThan(0);
      expect(maxChars).toBeLessThan(baseMaxChars);
      const promptTokens = estimateTokens(
        buildTopicRangesPrompt('', { preferContentLanguage: true, resplitParentPath: parentPath }),
      );
      const payloadTokens = estimateTokensForCharCount(maxChars, {
        bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
      });
      expect(promptTokens + payloadTokens + responseTokens).toBeLessThanOrEqual(SMALL_CONTEXT);
    }
  });

  it('skips resplitting when the parent path leaves no room for a tagged sentence', () => {
    expect(
      getResplitTextChunkMaxChars(
        getPipelineTextChunkMaxChars(SMALL_CONTEXT),
        '漢'.repeat(5000),
        true,
      ),
    ).toBe(0);
  });
});

describe('getArticleChatLimits', () => {
  it('shares a small provider budget between article source and conversation history', () => {
    const limits = getArticleChatLimits(SMALL_CONTEXT);
    expect(limits.maxChunkChars + limits.maxHistoryChars).toBe(
      getPipelineTextChunkMaxChars(SMALL_CONTEXT),
    );
    expect(limits.maxHistoryChars).toBeGreaterThan(0);
  });

  it('keeps established defaults when the provider context is unknown', () => {
    expect(getArticleChatLimits(undefined)).toEqual({
      maxChunkChars: ARTICLE_CHAT_MAX_CHUNK_CHARS,
      maxHistoryChars: ARTICLE_CHAT_MAX_HISTORY_CHARS,
    });
  });

  it('keeps the full budget for a context window larger than the pipeline fallback', () => {
    expect(getArticleChatLimits(OVERSIZED_CONTEXT)).toEqual(getArticleChatLimits(undefined));
  });

  it('agrees with the pipeline fallback that signals an unknown window', () => {
    const limits = getArticleChatLimits(undefined);
    expect(limits.maxChunkChars + limits.maxHistoryChars).toBe(PIPELINE_TEXT_CHUNK_MAX_CHARS);
  });
});
