// Output-token budget shared by the request planner and the provider clients.
//
// The planner sizes an input by how much *output* it may legitimately produce
// (a topic-ranges response can hold one hierarchical path per input sentence),
// while the client decides what output allowance to actually request from the
// provider. When those two numbers disagree, the provider silently stops at its
// own limit and returns a well-formed but incomplete body — so both sides read
// the budget from here.
//
// LLM_MAX_OUTPUT_TOKENS is the allowance requested when the provider declares
// no context window of its own. It is sent as Anthropic's `max_tokens` (a
// required-in-practice parameter whose per-model maximum varies), narrowed to
// the declared window by resolveMaxOutputTokens below. OpenAI-compatible
// requests leave the server default in place and rely on `finish_reason` to
// report truncation.
export const LLM_MAX_OUTPUT_TOKENS = 32000;

// The output allowance has to fit the window the user declared for the
// provider; Anthropic rejects a `max_tokens` its target cannot honor with a
// 400, and that status is non-retryable, so an over-large value fails every
// request in a run rather than degrading. Which window applies is the user's
// call — the setting is the only statement we have about the target model, so
// the budget follows it rather than second-guessing it from the model name.
//
// The reserve keeps room in the declared window for the request itself, since
// the window has to hold both sides.
const OUTPUT_BUDGET_INPUT_RESERVE_TOKENS = 1024;

/**
 * Output allowance to request from a provider. Both the client (which sends it)
 * and the planner (which must not size an input to produce more than it) read
 * the budget from here, so a narrowed allowance cannot desynchronize the two.
 *
 * An undeclared window keeps the full shared budget: no setting means no reason
 * to ask for less.
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

// A topic response may legitimately contain one distinct hierarchical path per
// input sentence. Budget enough output for that worst-case shape instead of
// letting the character budget admit hundreds of short, unrelated lines.
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
