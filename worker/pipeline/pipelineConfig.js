import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicRangesPrompt,
  buildTopicSummaryFromSourcePrompt,
} from './prompts.js';
import { PIPELINE_MIN_CONTEXT_WINDOW_TOKENS } from '../settings/contextWindowConstraints.js';
import { LLM_TEXT_FALLBACK_MAX_CHARS } from '../settings/textBudget.js';
import {
  estimateMaxCharsForTokens,
  estimateTokens,
  estimateTokensForCharCount,
  WORST_CASE_BYTES_PER_CODE_UNIT,
} from '../llm/tokenEstimator.js';

// Topic-range input includes sentence markers while source-summary input is raw
// text, so the stages keep distinct semantic names. They intentionally share
// one conservative fallback budget to keep request sizing consistent across the
// pipeline. Providers may declare a smaller context window; the per-run budget
// is then derived by getPipelineTextChunkMaxChars instead of blindly using this
// fallback.
export const PIPELINE_TEXT_CHUNK_MAX_CHARS = LLM_TEXT_FALLBACK_MAX_CHARS;

// Reserve room for provider tokenization variance and the response in addition
// to the largest static pipeline prompt.
const PIPELINE_CONTEXT_ADAPTIVE_RESERVE_MAX_TOKENS = 4096;
const PIPELINE_CONTEXT_RESERVED_RATIO = 0.75;
const PIPELINE_RESPONSE_RESERVED_TOKENS = 1024;
// A topic response may legitimately contain one distinct hierarchical path
// per input sentence. Budget enough output for that worst-case shape instead
// of letting the character budget admit hundreds of short, unrelated lines.
const TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE = 32;
export const TOPIC_RANGE_INPUT_MAX_SENTENCES = 240;

// Largest static prompt among pipeline stages, measured with the shared
// estimator (UTF-8-aware with safety factor). This is the fixed overhead
// used in all budget calculations.
export const PIPELINE_FIXED_PROMPT_TOKENS = Math.max(
  estimateTokens(buildTopicRangesPrompt('', { preferContentLanguage: true })),
  estimateTokens(buildArticleSummaryPrompt('', { preferContentLanguage: true })),
  estimateTokens(buildTopicSummaryFromSourcePrompt('', { preferContentLanguage: true })),
  estimateTokens(buildArticleSummaryMergePrompt('', { preferContentLanguage: true })),
  estimateTokens(buildLeafSummaryMergePrompt('', { preferContentLanguage: true })),
);

export const MAX_TAGGED_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;
export const SOURCE_SUMMARY_MAX_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;

/**
 * Normalizes an optional provider context-window declaration. Absent or
 * unusable values yield null so callers fall back to their static budget;
 * declared-but-too-small windows are a configuration error and throw.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @returns {number|null} Whole-token context window, or null when unknown.
 */
function normalizeContextTokens(contextWindowTokens) {
  const parsed = Number(contextWindowTokens);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const contextTokens = Math.floor(parsed);
  if (contextTokens < PIPELINE_MIN_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `Active provider "Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}. Update it in Options > LLM Providers.`,
    );
  }
  return contextTokens;
}

/**
 * Derives the source-text portion of a request from an optional provider
 * context-window declaration. Unknown windows retain the conservative 60k
 * fallback; known smaller windows reduce every pipeline stage consistently.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @returns {number}
 */
export function getPipelineTextChunkMaxChars(contextWindowTokens) {
  const contextTokens = normalizeContextTokens(contextWindowTokens);
  if (contextTokens === null) return PIPELINE_TEXT_CHUNK_MAX_CHARS;
  const reservedTokens = Math.max(
    PIPELINE_FIXED_PROMPT_TOKENS + PIPELINE_RESPONSE_RESERVED_TOKENS,
    Math.min(
      PIPELINE_CONTEXT_ADAPTIVE_RESERVE_MAX_TOKENS,
      Math.floor(contextTokens * PIPELINE_CONTEXT_RESERVED_RATIO),
    ),
  );
  const availableTokens = contextTokens - reservedTokens;
  if (availableTokens <= 0) {
    throw new Error(
      `Active provider "Context window (tokens)" must be at least ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS}. Update it in Options > LLM Providers.`,
    );
  }
  const maxChars = estimateMaxCharsForTokens(availableTokens);
  return Math.min(PIPELINE_TEXT_CHUNK_MAX_CHARS, maxChars);
}

/**
 * Caps topic-range markers by the response space reserved for the configured
 * context. Unknown provider windows retain the established 240-marker limit.
 *
 * The payload reserve assumes worst-case density (WORST_CASE_BYTES_PER_CODE_UNIT)
 * so the same ratio that sized maxChars is reused here; otherwise the payload
 * budget would be counted twice. This makes the sentence cap flat at 54 for
 * mid-size windows (8k–33k) — safe but ~4x more topic-ranging calls than
 * before at those sizes. If throughput matters, the orchestrator could measure
 * the actual chunk text at dispatch instead of assuming uniform worst-case density.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @returns {number}
 */
export function getTopicRangeInputMaxSentences(contextWindowTokens) {
  const contextTokens = normalizeContextTokens(contextWindowTokens);
  if (contextTokens === null) return TOPIC_RANGE_INPUT_MAX_SENTENCES;
  const maxChars = getPipelineTextChunkMaxChars(contextTokens);
  const payloadTokens = estimateTokensForCharCount(maxChars, {
    bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
  });
  const responseTokens = contextTokens - PIPELINE_FIXED_PROMPT_TOKENS - payloadTokens;
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

// The primary chunk dispatch and the oversize re-split share these: both are
// the same provider-facing topic-ranging workload and must be tuned together.
export const TOPIC_RANGE_CONCURRENCY = 4;
export const TOPIC_RANGE_TEMPERATURE = 0.2;
