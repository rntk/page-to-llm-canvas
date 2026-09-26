import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicRangesPrompt,
  buildTopicSummaryFromSourcePrompt,
} from './prompts.js';
import {
  ARTICLE_CHAT_MAX_HISTORY_CHARS,
  LLM_TEXT_FALLBACK_MAX_CHARS,
  PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
} from '../settings/llmBudgets.js';
import {
  LLM_MAX_OUTPUT_TOKENS,
  maxTopicRangeSentencesForOutputBudget,
  TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE,
} from '../llm/outputBudget.js';
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
// The static ceiling on topic-input sentences is whatever worst-case response
// (one hierarchical path per input sentence) still fits the output allowance
// the client actually requests. Deriving it from the shared budget keeps the
// planner from sizing a chunk the provider would answer with a truncated body.
export const TOPIC_RANGE_INPUT_MAX_SENTENCES =
  maxTopicRangeSentencesForOutputBudget(LLM_MAX_OUTPUT_TOKENS);

// Baseline prompt overhead for pipeline budgeting, measured with the shared
// estimator (UTF-8-aware with safety factor). Resplit paths are model-generated
// and unbounded, so getResplitTextChunkMaxChars accounts for their actual cost.
export const PIPELINE_FIXED_PROMPT_TOKENS = Math.max(
  estimateTokens(buildTopicRangesPrompt('', { preferContentLanguage: true })),
  estimateTokens(
    buildTopicRangesPrompt('', {
      preferContentLanguage: true,
      resplitParentPath: 'Technology>Artificial Intelligence>Language Models>Prompt Caching',
    }),
  ),
  estimateTokens(buildArticleSummaryPrompt('', { preferContentLanguage: true })),
  estimateTokens(buildTopicSummaryFromSourcePrompt('', { preferContentLanguage: true })),
  estimateTokens(buildArticleSummaryMergePrompt('', { preferContentLanguage: true })),
  estimateTokens(buildLeafSummaryMergePrompt('', { preferContentLanguage: true })),
);

export const MAX_TAGGED_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;
export const SOURCE_SUMMARY_MAX_CHARS = PIPELINE_TEXT_CHUNK_MAX_CHARS;

/**
 * Reduce a resplit's payload allowance when its actual parent path makes the
 * prompt larger than the pipeline baseline. Charging the excess to the text
 * budget preserves the response space already reserved for topic ranges.
 * Return zero if even a sentence marker cannot fit; resplitting is optional.
 *
 * @param {number} baseMaxChars Pipeline text cap for this provider.
 * @param {string} parentPath Model-generated parent path.
 * @param {boolean} [preferContentLanguage]
 * @returns {number}
 */
export function getResplitTextChunkMaxChars(
  baseMaxChars,
  parentPath,
  preferContentLanguage = false,
) {
  const promptTokens = estimateTokens(
    buildTopicRangesPrompt('', { preferContentLanguage, resplitParentPath: parentPath }),
  );
  const excessTokens = Math.max(0, promptTokens - PIPELINE_FIXED_PROMPT_TOKENS);
  if (excessTokens === 0) return baseMaxChars;
  const payloadTokens = estimateTokensForCharCount(baseMaxChars, {
    bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
  });
  const remainingTokens = payloadTokens - excessTokens;
  // "{0} " is the shortest parseable tagged sentence line.
  if (remainingTokens < estimateTokensForCharCount(4)) return 0;
  return Math.min(baseMaxChars, estimateMaxCharsForTokens(remainingTokens));
}

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
 * Derives article-chat budgets from the pipeline budget. The pipeline budget
 * is already estimator-derived; chat splits it between source and history so
 * their sum fits the same window. Fixed overhead and response sizes differ
 * from the pipeline, but the variable-text estimator is shared.
 * @param {unknown} contextWindowTokens
 * @returns {{maxChunkChars: number, maxHistoryChars: number}}
 */
export function getArticleChatLimits(contextWindowTokens) {
  const textBudget = getPipelineTextChunkMaxChars(contextWindowTokens);
  const maxHistoryChars = Math.min(ARTICLE_CHAT_MAX_HISTORY_CHARS, Math.floor(textBudget / 3));
  return {
    maxChunkChars: Math.max(1, textBudget - maxHistoryChars),
    maxHistoryChars,
  };
}

/**
 * Caps topic-range markers by the response space reserved for the configured
 * context. Unknown provider windows retain the output-budget ceiling alone
 * (TOPIC_RANGE_INPUT_MAX_SENTENCES, unless the model allows less output).
 *
 * The payload reserve assumes worst-case density (WORST_CASE_BYTES_PER_CODE_UNIT)
 * so the same ratio that sized maxChars is reused here; otherwise the payload
 * budget would be counted twice. This makes the sentence cap nearly flat for
 * mid-size windows (8k–33k) — safe but more topic-ranging calls than
 * before at those sizes. If throughput matters, the orchestrator could measure
 * the actual chunk text at dispatch instead of assuming uniform worst-case density.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @param {number} [maxOutputTokens] Allowance the client will actually request
 *   (resolveMaxOutputTokens). A model whose ceiling is below the shared budget
 *   stops sooner than the static ceiling assumes, so the cap is derived from it.
 * @returns {number}
 */
export function getTopicRangeInputMaxSentences(
  contextWindowTokens,
  maxOutputTokens = LLM_MAX_OUTPUT_TOKENS,
) {
  const outputCeiling = maxTopicRangeSentencesForOutputBudget(maxOutputTokens);
  const contextTokens = normalizeContextTokens(contextWindowTokens);
  if (contextTokens === null) return outputCeiling;
  const maxChars = getPipelineTextChunkMaxChars(contextTokens);
  const payloadTokens = estimateTokensForCharCount(maxChars, {
    bytesPerChar: WORST_CASE_BYTES_PER_CODE_UNIT,
  });
  const responseTokens = contextTokens - PIPELINE_FIXED_PROMPT_TOKENS - payloadTokens;
  return Math.min(
    outputCeiling,
    Math.max(1, Math.floor(responseTokens / TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE)),
  );
}

// Keep retry layering explicit. Topic ranging owns a stage retry loop that can
// checkpoint successful chunks, so each dispatch gets one provider attempt.
// Summary calls have no automatic stage retry and therefore retain transport
// retries locally. This prevents the old 4 x 3 multiplicative topic budget.
export const TOPIC_RANGE_STAGE_MAX_RETRIES = 3;
export const TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS = 1;
export const SUMMARY_PROVIDER_MAX_ATTEMPTS = 3;
export const SUMMARY_MAX_MERGE_ROUNDS = 8;

// Leaf summaries and internal-node source summaries share one concurrency cap;
// together they form the provider-facing summary workload.
export const SUMMARY_CONCURRENCY = 4;

// The primary chunk dispatch and the manual topic resplit share this: both are
// the same provider-facing topic-ranging workload and must be tuned together.
// Sampling temperature is not set here — it comes from the active provider's
// per-task configuration, and stays unset (unsent) unless configured.
export const TOPIC_RANGE_CONCURRENCY = 4;
