// Pure pending-work detection for the per-topic summary stage.
//
// Given the topic list and the summaries carried over from a resumed run, decide
// which topics can reuse their stored summary and which still need an LLM call.
// A previous summary is reusable only when it is present AND not flagged with
// `error: true`. The error flag is the in-flight retry marker: a leaf whose LLM
// call failed is stored with `error: true` so a resumed run re-queries it, while
// a legit NO_SUMMARY (empty text, no flag) is reused as-is and never retried.
//
// This function performs no I/O and mutates nothing; the orchestrator owns the
// resulting state mutation and logging.

/**
 * @param {Array<{name: string, sentences: number[]}>} topics
 * @param {Record<string, {text?: string, error?: boolean}>} previousSummaries
 * @returns {{
 *   reused: Record<string, {text: string, source_sentences: number[]}>,
 *   pending: Array<object>,
 *   reusedCount: number,
 *   pendingCount: number,
 *   total: number,
 * }}
 */
export function planSummaryWork(topics, previousSummaries = {}) {
  const reused = {};
  const pending = [];
  for (const topic of topics) {
    const prev = previousSummaries[topic.name];
    if (prev && !prev.error) {
      reused[topic.name] = {
        text: prev.text || '',
        source_sentences: topic.sentences,
      };
    } else {
      pending.push(topic);
    }
  }
  const total = topics.length;
  const pendingCount = pending.length;
  return {
    reused,
    pending,
    reusedCount: total - pendingCount,
    pendingCount,
    total,
  };
}
