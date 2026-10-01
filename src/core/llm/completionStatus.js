// Normalize provider finish reasons so callers can reject truncated HTTP 200
// responses. UNKNOWN is not treated as truncation because some compatible
// servers omit finish_reason.

/** @enum {string} */
export const FinishReason = Object.freeze({
  COMPLETE: 'complete',
  TRUNCATED: 'truncated',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

// Output or context limit reached: the response is missing its tail.
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'model_context_window_exceeded']);
// Anthropic's pause_turn is valid text, not token-limit truncation.
const COMPLETE_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'pause_turn']);
// Tool calls continue the chat turn.
const TOOL_CALL_REASONS = new Set(['tool_calls', 'function_call', 'tool_use']);
const CONTENT_FILTER_REASONS = new Set(['content_filter', 'refusal']);

/**
 * Maps a raw provider finish/stop reason onto the internal vocabulary.
 * Absent or unrecognized values become UNKNOWN.
 *
 * @param {unknown} rawReason Provider `finish_reason` / `stop_reason` value.
 * @returns {string} A `FinishReason` value.
 */
export function normalizeFinishReason(rawReason) {
  if (typeof rawReason !== 'string') return FinishReason.UNKNOWN;
  const reason = rawReason.trim().toLowerCase();
  if (!reason) return FinishReason.UNKNOWN;
  if (TRUNCATED_REASONS.has(reason)) return FinishReason.TRUNCATED;
  if (COMPLETE_REASONS.has(reason)) return FinishReason.COMPLETE;
  if (TOOL_CALL_REASONS.has(reason)) return FinishReason.TOOL_CALLS;
  if (CONTENT_FILTER_REASONS.has(reason)) return FinishReason.CONTENT_FILTER;
  if (reason === 'error') return FinishReason.ERROR;
  return FinishReason.UNKNOWN;
}

// Message used whenever a truncated response is rejected. Exported so error
// classifiers can recognize it without re-deriving the wording.
export const TRUNCATED_RESPONSE_ERROR =
  'LLM response was truncated at the provider output-token limit; retry with less input';

/**
 * @param {unknown} finishReason A normalized `FinishReason` value.
 * @returns {boolean} Whether the provider cut the response off at its output limit.
 */
export function isTruncatedFinish(finishReason) {
  return finishReason === FinishReason.TRUNCATED;
}
