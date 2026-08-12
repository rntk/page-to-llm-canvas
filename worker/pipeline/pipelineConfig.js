import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicRangesPrompt,
  buildTopicSummaryFromSourcePrompt,
} from './prompts.js';
import { PIPELINE_MIN_CONTEXT_WINDOW_TOKENS } from '../settings/contextWindowConstraints.js';

// Topic-range input includes sentence markers while source-summary input is raw
// text, so the stages keep distinct semantic names. They intentionally share
// one conservative fallback budget to keep request sizing consistent across the
// pipeline. Providers may declare a smaller context window; the per-run budget
// is then derived by getPipelineTextChunkMaxChars instead of blindly using this
// fallback.
const PIPELINE_TEXT_CHUNK_MAX_CHARS = 60000;

// Reserve room for provider tokenization variance and the response in addition
// to the largest static pipeline prompt. Character counts are deliberately
// converted at only two chars per token: this is conservative for ordinary
// prose and much safer for code, minified data, and non-Latin text than the
// usual four-char approximation.
const PIPELINE_CONTEXT_ADAPTIVE_RESERVE_MAX_TOKENS = 4096;
const PIPELINE_CONTEXT_RESERVED_RATIO = 0.75;
const PIPELINE_CONTEXT_CHARS_PER_TOKEN = 2;
const PIPELINE_RESPONSE_RESERVED_TOKENS = 1024;
// A topic response may legitimately contain one distinct hierarchical path
// per input sentence. Budget enough output for that worst-case shape instead
// of letting the character budget admit hundreds of short, unrelated lines.
const TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE = 32;
export const TOPIC_RANGE_INPUT_MAX_SENTENCES = 240;
const PIPELINE_FIXED_PROMPT_MAX_CHARS = Math.max(
  buildTopicRangesPrompt('', { preferContentLanguage: true }).length,
  buildArticleSummaryPrompt('', { preferContentLanguage: true }).length,
  buildTopicSummaryFromSourcePrompt('', { preferContentLanguage: true }).length,
  buildArticleSummaryMergePrompt('', { preferContentLanguage: true }).length,
  buildLeafSummaryMergePrompt('', { preferContentLanguage: true }).length,
);
const PIPELINE_FIXED_PROMPT_RESERVED_TOKENS = Math.ceil(
  PIPELINE_FIXED_PROMPT_MAX_CHARS / PIPELINE_CONTEXT_CHARS_PER_TOKEN,
);
export const MAX_TAGGED_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;
export const SOURCE_SUMMARY_MAX_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;

/**
 * Derives the source-text portion of a request from an optional provider
 * context-window declaration. Unknown windows retain the conservative 60k
 * fallback; known smaller windows reduce every pipeline stage consistently.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @returns {number}
 */
export function getPipelineTextChunkMaxChars(contextWindowTokens) {
  const parsed = Number(contextWindowTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return PIPELINE_TEXT_CHUNK_MAX_CHARS;
  const contextTokens = Math.floor(parsed);
  if (contextTokens < PIPELINE_MIN_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `Active provider "Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}. Update it in Options > LLM Providers.`,
    );
  }
  const reservedTokens = Math.max(
    PIPELINE_FIXED_PROMPT_RESERVED_TOKENS + PIPELINE_RESPONSE_RESERVED_TOKENS,
    Math.min(
      PIPELINE_CONTEXT_ADAPTIVE_RESERVE_MAX_TOKENS,
      Math.floor(contextTokens * PIPELINE_CONTEXT_RESERVED_RATIO),
    ),
  );
  const availableTokens = contextTokens - reservedTokens;
  return Math.min(
    PIPELINE_TEXT_CHUNK_MAX_CHARS,
    availableTokens * PIPELINE_CONTEXT_CHARS_PER_TOKEN,
  );
}

/**
 * Caps topic-range markers by the response space reserved for the configured
 * context. Unknown provider windows retain the established 240-marker limit.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @returns {number}
 */
export function getTopicRangeInputMaxSentences(contextWindowTokens) {
  const parsed = Number(contextWindowTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return TOPIC_RANGE_INPUT_MAX_SENTENCES;
  const contextTokens = Math.floor(parsed);
  if (contextTokens < PIPELINE_MIN_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `Active provider "Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}. Update it in Options > LLM Providers.`,
    );
  }
  const payloadTokens = Math.ceil(
    getPipelineTextChunkMaxChars(contextTokens) / PIPELINE_CONTEXT_CHARS_PER_TOKEN,
  );
  const responseTokens = contextTokens - PIPELINE_FIXED_PROMPT_RESERVED_TOKENS - payloadTokens;
  return Math.min(
    TOPIC_RANGE_INPUT_MAX_SENTENCES,
    Math.max(1, Math.floor(responseTokens / TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE)),
  );
}

// Keep retry layering explicit. Topic ranging owns a stage retry loop that can
// checkpoint successful chunks, so each dispatch gets one provider attempt.
// Summary calls have no automatic stage retry and therefore retain transport
// retries locally. This prevents the old 4 x 3 multiplicative topic budget.
export const TOPIC_RANGE_STAGE_MAX_RETRIES = 3;
export const TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS = 1;
export const TOPIC_RANGE_RESPLIT_PROVIDER_MAX_ATTEMPTS = 3;
export const SUMMARY_PROVIDER_MAX_ATTEMPTS = 3;
export const SUMMARY_MAX_MERGE_ROUNDS = 8;

// Leaf summaries and internal-node source summaries share one concurrency cap;
// together they form the provider-facing summary workload.
export const SUMMARY_CONCURRENCY = 4;
