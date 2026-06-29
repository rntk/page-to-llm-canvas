// Topic-tree summary index builder, extracted from the orchestrator.
//
// Given a built topic tree (root + nodes map, see buildTopicTree) and the leaf
// summaries, this produces the topic_summary_index keyed by path. The summary
// for each node is decided per node:
//
//   - leaf node (no children): its precomputed per-topic leafSummary (or '')
//   - single-child node whose source is identical to that child's: it DELEGATES
//     to the child's summary instead of generating its own. buildTopicTree
//     aggregates every descendant sentence onto each node, so a node with one
//     child usually covers the exact same sentences as that child — generating a
//     fresh summary would just re-summarize text the child already represents.
//     Delegation chains down through such single-child links until it reaches a
//     node that owns distinct content (see below). NOTE: an internal node can
//     also have its OWN sentences beyond its single child (a topic line assigns
//     sentences to an intermediate path); then its source is a strict superset
//     of the child's, delegating would drop the parent's own content, so it does
//     NOT delegate and is summarized from source instead. The sameSource guard
//     distinguishes the two — both arrays are sorted by buildTopicTree, so a
//     length + element-wise comparison is exact.
//   - any other internal node (>=2 children, or 1 child with extra sentences):
//     a FRESH summary generated from the node's own aggregated source sentences
//     via the injected summarizeSource. We do NOT merge the children's brief
//     summaries — a summary-of-summaries loses facts at every level.
//     summarizeSource owns the fit-vs-chunk+merge decision and all LLM calls; on
//     failure we invoke onError (attributed to the node that actually generates,
//     i.e. the delegation anchor) and fall back to { text: '' }.
//   - the empty root path is skipped: it is excluded from the index, and
//     summarizing it would needlessly re-summarize the entire document.
//
// Resolution is memoized by path so a delegating parent and its anchor share a
// single resolve() promise — the anchor's summarizeSource runs exactly once even
// though several ancestors delegate to it. Nodes are still resolved with a flat
// concurrent fan-out; real LLM concurrency is bounded inside summarizeSource
// (which wraps each call in the shared limiter). All side effects (LLM calls,
// logging) are injected, so this module performs no storage I/O and is
// unit-testable with fakes.

/**
 * @param {object} params
 * @param {Map<string, {path: string, level: number, children: object[], sourceSentences: number[], summary?: object}>} params.nodes
 * @param {Record<string, {text?: string}>} params.leafSummaries  keyed by topic path
 * @param {(sourceSentenceIds: number[], info: {path: string}) => Promise<{text: string}>} params.summarizeSource
 * @param {(info: {path: string, error: unknown}) => (void | Promise<void>)} [params.onError]
 * @returns {Promise<Record<string, {text: string, level: number, source_sentences: number[]}>>}
 */
export async function summarizeTopicTree({ nodes, leafSummaries, summarizeSource, onError }) {
  const summarizable = [...nodes.values()].filter((node) => node.path);

  // Two sorted sentence-id lists cover the same source iff they are equal.
  const sameSource = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // Resolve a node's summary, delegating single-child passthroughs to their
  // anchor. Memoized by path so each anchor is generated once even when several
  // ancestors delegate to it.
  const resolving = new Map();
  const resolve = (node) => {
    if (resolving.has(node.path)) return resolving.get(node.path);
    const p = (async () => {
      if (node.children.length === 0) {
        const leaf = leafSummaries[node.path];
        return { text: (leaf && leaf.text) || '' };
      }
      if (
        node.children.length === 1 &&
        sameSource(node.sourceSentences, node.children[0].sourceSentences)
      ) {
        return resolve(node.children[0]);
      }
      try {
        return await summarizeSource(node.sourceSentences, { path: node.path });
      } catch (e) {
        if (onError) {
          await onError({ path: node.path, error: e });
        }
        return { text: '' };
      }
    })();
    resolving.set(node.path, p);
    return p;
  };

  await Promise.all(
    summarizable.map(async (node) => {
      node.summary = await resolve(node);
    }),
  );

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
