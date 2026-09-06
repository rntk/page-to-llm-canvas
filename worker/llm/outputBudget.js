// Output-token budget shared by the request planner and the provider clients.
//
// The planner sizes an input by how much *output* it may legitimately produce
// (a topic-ranges response can hold one hierarchical path per input sentence),
// while the client decides what output allowance to actually request from the
// provider. When those two numbers disagree, the provider silently stops at its
// own limit and returns a well-formed but incomplete body — so both sides read
// the budget from here.
//
// LLM_MAX_OUTPUT_TOKENS is deliberately conservative: it is sent as Anthropic's
// `max_tokens` (a required-in-practice parameter whose per-model maximum varies,
// and older models reject values above 4096 with a 400). OpenAI-compatible
// requests leave the server default in place and rely on `finish_reason` to
// report truncation; the planner's reservation still has to fit this budget,
// since it is the smallest allowance any supported provider will grant.
export const LLM_MAX_OUTPUT_TOKENS = 32000;

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
