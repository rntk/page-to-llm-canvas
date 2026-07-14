// Realm-neutral telemetry protocol constants. Both bundled UI code and the
// unbundled extension worker import these ids without depending on each
// other's implementation modules.

export const LLM_TASK_TYPES = Object.freeze({
  TOPIC_RANGES: 'topic_ranges',
  ARTICLE_SUMMARY: 'article_summary',
  TOPIC_SUMMARY_FROM_SOURCE: 'topic_summary_from_source',
  ARTICLE_SUMMARY_MERGE: 'article_summary_merge',
  CHAT_ANSWER: 'chat_answer',
  CHAT_SYNTHESIS: 'chat_synthesis',
  UNKNOWN: 'unknown',
});

export const CHAT_TOOL_OUTCOMES = Object.freeze({
  HIGHLIGHTED: 'highlighted',
  OVERLAP_SKIPPED: 'overlap_skipped',
  UNKNOWN_TOOL: 'unknown_tool',
  INVALID_ARGUMENTS: 'invalid_arguments',
  OUT_OF_RANGE: 'out_of_range',
  OUT_OF_CHUNK: 'out_of_chunk',
  PAINT_FAILED: 'paint_failed',
});
