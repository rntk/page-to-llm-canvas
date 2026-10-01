// Shared output budget keeps the planner's input sizing aligned with the
// Anthropic allowance requested by clients. OpenAI-compatible servers use
// their default and report truncation through finish_reason.
export const LLM_MAX_OUTPUT_TOKENS = 32000;

// Reserve input space within the user-declared window; Anthropic rejects an
// output allowance larger than the remaining window.
const OUTPUT_BUDGET_INPUT_RESERVE_TOKENS = 1024;

/**
 * Output allowance shared by the client and planner. An undeclared window
 * uses the full shared budget.
 *
 * @param {unknown} contextWindowTokens Declared provider context window.
 * @returns {number} Allowance in tokens, at least 1.
 */
export function resolveMaxOutputTokens(contextWindowTokens) {
  const declared = Number(contextWindowTokens);
  if (!Number.isFinite(declared) || declared <= 0) return LLM_MAX_OUTPUT_TOKENS;
  const available = Math.floor(declared) - OUTPUT_BUDGET_INPUT_RESERVE_TOKENS;
  return Math.max(1, Math.min(LLM_MAX_OUTPUT_TOKENS, available));
}

// Allow one distinct hierarchical path per input sentence.
export const TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE = 32;

/**
 * Largest sentence count whose worst-case topic-ranges response still fits the
 * output allowance the client requests.
 *
 * @param {number} [maxOutputTokens] Output allowance in tokens.
 * @returns {number} Whole sentence count, at least 1.
 */
export function maxTopicRangeSentencesForOutputBudget(maxOutputTokens = LLM_MAX_OUTPUT_TOKENS) {
  return Math.max(1, Math.floor(maxOutputTokens / TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE));
}
