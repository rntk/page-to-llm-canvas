// Bottom-up topic-tree merge, extracted from the orchestrator.
//
// Given a built topic tree (root + nodes map, see buildTopicTree) and the leaf
// summaries, this walks the tree depth-first merging children into parents. The
// merge LLM call, the concurrency limiter, and all side effects (the merge-error
// log) are injected so this module performs no storage I/O and is unit-testable
// with fakes. It returns the topic_summary_index keyed by path; the orchestrator
// persists it.
//
// Merge semantics (preserved exactly from the inline original):
//   - leaf node (no children): summary = its leafSummary, or { text: '' }
//   - single child: summary = that child's summary (no LLM call)
//   - multiple children: merge their summaries via mergeFn; on failure invoke
//     onMergeError and fall back to { text: '' }
//   - sibling subtrees run concurrently; each level still awaits its children, so
//     merges stay bottom-up. mergeFn is wrapped in the limiter to bound in-flight
//     merge LLM calls.

/**
 * @param {object} params
 * @param {{path: string, children: object[], leafSummary: ?object, summary?: object}} params.root
 * @param {Map<string, object>} params.nodes
 * @param {Record<string, {text?: string}>} params.leafSummaries  keyed by topic path
 * @param {(childRecords: Array<{start_sentence: number, end_sentence: number, summary: {text: string}}>) => Promise<{text: string}>} params.merge
 * @param {<T>(fn: () => Promise<T>) => Promise<T>} params.limit  concurrency limiter
 * @param {(info: {path: string, error: string}) => (void | Promise<void>)} [params.onMergeError]
 * @returns {Promise<Record<string, {text: string, level: number, source_sentences: number[]}>>}
 */
export async function summarizeTopicTree({
  root,
  nodes,
  leafSummaries,
  merge,
  limit,
  onMergeError,
}) {
  // Seed leaf summaries onto their nodes.
  for (const [path, node] of nodes) {
    if (path && leafSummaries[path]) {
      node.leafSummary = {
        text: leafSummaries[path].text || '',
      };
    }
  }

  async function summarizeNode(node) {
    // Sibling subtrees are independent; merge them concurrently. Each level
    // still waits on its children, so merges stay bottom-up.
    await Promise.all(node.children.map((child) => summarizeNode(child)));
    if (node.children.length === 0) {
      node.summary = node.leafSummary || { text: '' };
      return;
    }
    if (node.children.length === 1) {
      node.summary = node.children[0].summary;
      return;
    }
    const records = node.children.map((c) => {
      const sents = c.sourceSentences;
      return {
        start_sentence: sents[0] || 0,
        end_sentence: sents[sents.length - 1] || 0,
        summary: c.summary || { text: '' },
      };
    });
    try {
      node.summary = await limit(() => merge(records));
    } catch (e) {
      if (onMergeError) {
        await onMergeError({ path: node.path, error: (e && e.message) || String(e) });
      }
      node.summary = { text: '' };
    }
  }
  await summarizeNode(root);

  const topicSummaryIndex = {};
  for (const [path, node] of nodes) {
    if (!path) continue;
    topicSummaryIndex[path] = {
      text: (node.summary && node.summary.text) || '',
      level: node.level - 1,
      source_sentences: node.sourceSentences,
    };
  }
  return topicSummaryIndex;
}
