// Normalized completion status for provider HTTP responses.
//
// Every provider reports why generation stopped, under a different name and a
// different vocabulary: OpenAI-compatible servers use `choices[].finish_reason`
// ("stop" / "length" / "tool_calls" / "content_filter"), the Anthropic Messages
// API uses `stop_reason` ("end_turn" / "max_tokens" / "stop_sequence" /
// "tool_use" / "refusal" / ...). The clients collapse both into the internal
// vocabulary below so callers can ask one question — "is this response the
// whole answer?" — without knowing which provider produced it.
//
// TRUNCATED is the load-bearing value: a response cut off at the output-token
// limit is a *successful* HTTP 200 whose body is missing its tail. Text callers
// must reject it instead of parsing a partial answer as a complete one.
// UNKNOWN means the provider said nothing usable (a field some OpenAI-compatible
// servers omit); it is deliberately not treated as truncation, since guessing
// would fail every response from those servers.

/** @enum {string} */
export const FinishReason = Object.freeze({
  COMPLETE: 'complete',
  TRUNCATED: 'truncated',
  TOOL_CALLS: 'tool_calls',
  CONTENT_FILTER: 'content_filter',
  ERROR: 'error',
  UNKNOWN: 'unknown',
});

// Values that mean "output stopped at a token limit". `max_tokens` is
// Anthropic's; `length` is OpenAI's (and Ollama's `done_reason`).
// `model_context_window_exceeded` is Anthropic's newer variant for a request
// that ran out of context window mid-generation — also a missing tail.
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'model_context_window_exceeded']);
// Normal completion: the model chose to stop, or hit a caller stop sequence.
// `pause_turn` (Anthropic pausing a long server-tool turn) belongs here too:
// the text produced so far is valid and nothing was cut off at a token limit.
const COMPLETE_REASONS = new Set(['stop', 'end_turn', 'stop_sequence', 'pause_turn']);
// The model stopped to call a tool. Complete for chat (the tool result
// continues the turn), and never produced by the pipeline's text-only calls.
const TOOL_CALL_REASONS = new Set(['tool_calls', 'function_call', 'tool_use']);
const CONTENT_FILTER_REASONS = new Set(['content_filter', 'refusal']);

/**
 * Maps a raw provider finish/stop reason onto the internal vocabulary.
 * Absent or unrecognized values become UNKNOWN — callers must not read that as
 * truncation (see file header).
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
