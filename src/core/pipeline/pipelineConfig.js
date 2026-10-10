import {
  buildArticleSummaryMergePrompt,
  buildArticleSummaryPrompt,
  buildLeafSummaryMergePrompt,
  buildTopicLabelsPrompt,
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

// Share a conservative fallback across topic and source text; provider context
// windows can reduce it through getPipelineTextChunkMaxChars.
export const PIPELINE_TEXT_CHUNK_MAX_CHARS = LLM_TEXT_FALLBACK_MAX_CHARS;

// Reserve room for provider tokenization variance and the response in addition
// to the largest static pipeline prompt.
const PIPELINE_CONTEXT_ADAPTIVE_RESERVE_MAX_TOKENS = 4096;
const PIPELINE_CONTEXT_RESERVED_RATIO = 0.75;
const PIPELINE_RESPONSE_RESERVED_TOKENS = 1024;
// Bound sentence count so a worst-case response fits the requested output budget.
export const TOPIC_RANGE_INPUT_MAX_SENTENCES =
  maxTopicRangeSentencesForOutputBudget(LLM_MAX_OUTPUT_TOKENS);

// The baseline uses the shared estimator; resplits charge for longer parent paths.
export const PIPELINE_FIXED_PROMPT_TOKENS = Math.max(
  estimateTokens(buildTopicRangesPrompt('', { preferContentLanguage: true })),
  estimateTokens(buildTopicLabelsPrompt('', { preferContentLanguage: true })),
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
 * Charge a longer resplit parent path to the text budget while preserving
 * reserved response space. Return zero if a tagged sentence cannot fit.
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
 * Split the estimator-derived text budget between article source and chat history.
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
 * Cap topic-range markers by reserved response space. Unknown context windows
 * use only the output ceiling. Worst-case text density prevents double counting
 * the payload budget, at the cost of smaller chunks for some providers.
 *
 * @param {unknown} contextWindowTokens Provider context window in tokens.
 * @param {number} [maxOutputTokens] Output allowance actually requested.
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

// Topic chunks retry at the stage level; summaries retain provider retries.
export const TOPIC_RANGE_STAGE_MAX_RETRIES = 3;
export const TOPIC_RANGE_PROVIDER_MAX_ATTEMPTS = 1;
export const SUMMARY_PROVIDER_MAX_ATTEMPTS = 3;
export const SUMMARY_MAX_MERGE_ROUNDS = 8;

// Leaf and internal source summaries share this provider concurrency cap.
export const SUMMARY_CONCURRENCY = 4;

// Initial topic splits and manual resplits share this provider concurrency cap.
export const TOPIC_RANGE_CONCURRENCY = 4;
