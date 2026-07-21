// Topic-tree summary index builder, extracted from the orchestrator.
//
// Given a built topic tree (root + nodes map, see buildTopicTree) and the leaf
// summaries, this produces the topic_summary_index keyed by path. Each node's
// summary is a list of per-run entries ({sentences, text}) — one per contiguous
// occurrence of the topic — so a topic scattered through the article carries
// location-specific text per occurrence instead of one blob repeated everywhere.
//
// The unit of work is the RUN, not the node. A node's aggregated source splits
// into contiguous runs (one per non-adjacent occurrence); each run is resolved
// on its own:
//
//   - leaf node (no children): its precomputed leafSummaries entry (or [])
//   - internal node, run owned by a single child: the run DELEGATES to that
//     child's matching run summary instead of generating its own. buildTopicTree
//     aggregates every descendant sentence onto each node, so when a run's
//     sentences all come from one child, re-summarizing them would just re-do
//     text that child already represents — we never generate a summary for text a
//     subtopic already covers. A run owned by a single child is provably equal to
//     exactly one of that child's runs (a child sentence adjacent to the run
//     would also be in the parent, breaking the run's maximality), so the
//     matching run always exists. Delegation chains down single-child links until
//     it reaches a run a leaf owns.
//   - internal node, run that mixes content: a run covering >=2 children, or one
//     that includes the node's OWN topic-line sentences (a sentence in the run
//     belonging to no child), is summarized FRESH from source. We do NOT merge
//     the children's brief summaries — a summary-of-summaries loses facts at
//     every level. All such runs of a node are summarized in one summarizeSource
//     call over just their sentences; summarizeSource owns the fit-vs-chunk+merge
//     decision and re-splits them back into the same runs (distinct node runs are
//     gap-separated, so they survive the round trip). On failure we invoke
//     onError (attributed to the generating node) and degrade the generated runs
//     to empty text, keeping any reused runs intact.
//   - the empty root path is skipped: it is excluded from the index, and
//     summarizing it would needlessly re-summarize the entire document.
//
// Resolution is memoized by path so a parent reusing a child's runs and that
// child share a single resolve() promise — the child's summarizeSource runs
// exactly once even when several ancestors reuse it. Nodes are still resolved
// with a flat concurrent fan-out; real LLM concurrency is bounded inside
// summarizeSource (which wraps each call in the shared limiter). All side effects
// (LLM calls, logging) are injected, so this module performs no storage I/O and
// is unit-testable with fakes.

/**
 * Builds the worker's summary tree from flat hierarchical topic paths and
 * aggregates descendant sentence ids onto every parent node.
 *
 * @param {Array<{name?: string, sentences?: number[]}>} topics
 * @returns {{root: object, nodes: Map<string, object>}}
 */
export function buildTopicTree(topics) {
  const root = {
    path: '',
    name: '',
    level: 0,
    children: [],
    sourceSentences: [],
  };
  const nodes = new Map([['', root]]);

  function getOrCreate(path) {
    if (nodes.has(path)) return nodes.get(path);
    const parts = path.split('>');
    const parentPath = parts.slice(0, -1).join('>');
    // Every recursive step must move toward the root. Besides documenting the
    // path invariant, this turns a malformed derivation into a local error
    // instead of unbounded self/growing recursion and a crashed worker.
    if (parentPath.length >= path.length) {
      throw new Error(`Invalid topic path: parent does not shrink (${path})`);
    }
    const parent = getOrCreate(parentPath);
    const node = {
      path,
      name: parts[parts.length - 1],
      level: parts.length,
      children: [],
      sourceSentences: [],
    };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  }

  for (const topic of topics) {
    if (!topic.name || topic.name === 'no_topic') continue;
    const node = getOrCreate(topic.name);
    if (Array.isArray(topic.sentences)) {
      node.sourceSentences.push(...topic.sentences);
    }
  }

  function aggregate(node) {
    const aggregated = new Set(node.sourceSentences);
    for (const child of node.children) {
      for (const sentence of aggregate(child)) aggregated.add(sentence);
    }
    node.sourceSentences = Array.from(aggregated).sort((a, b) => a - b);
    return node.sourceSentences;
  }
  aggregate(root);

  return { root, nodes };
}

/**
 * Splits a sorted set of 1-based sentence ids into contiguous runs. A topic that
 * appears at several non-adjacent places in the article yields one run per
 * occurrence; each run is summarized separately so the same topic shows
 * location-specific text instead of one global summary repeated everywhere.
 *
 * @param {number[]} sentenceIds
 * @returns {number[][]} ordered runs of consecutive ids
 */
export function splitContiguousRuns(sentenceIds) {
  const sorted = Array.isArray(sentenceIds) ? sentenceIds.slice().sort((a, b) => a - b) : [];
  const runs = [];
  let cur = [];
  for (const id of sorted) {
    if (cur.length === 0 || id === cur[cur.length - 1] + 1) {
      cur.push(id);
    } else {
      runs.push(cur);
      cur = [id];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Each summary is a list of per-run entries ({sentences, text}), one per
 * contiguous occurrence of the topic, rather than a single text blob.
 *
 * @param {object} params
 * @param {Map<string, {path: string, level: number, children: object[], sourceSentences: number[], summary?: object}>} params.nodes
 * @param {Record<string, {runs?: Array<{sentences: number[], text: string}>}>} params.leafSummaries  keyed by topic path
 * @param {(sourceSentenceIds: number[], info: {path: string}) => Promise<{runs: Array<{sentences: number[], text: string}>}>} params.summarizeSource
 * @param {(info: {path: string, error: unknown}) => (void | Promise<void>)} [params.onError]
 * @returns {Promise<Record<string, {runs: Array<{sentences: number[], text: string}>, level: number, source_sentences: number[]}>>}
 */
export async function summarizeTopicTree({ nodes, leafSummaries, summarizeSource, onError }) {
  const summarizable = [...nodes.values()].filter((node) => node.path);

  // Two sorted sentence-id lists cover the same source iff they are equal.
  const sameSource = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  // The child a run delegates to, or null if the run must be summarized fresh. A
  // run delegates only when every one of its sentences belongs to a single child
  // (no mixing with sibling children, no node-own topic-line sentences) — that is
  // the "run with one subtopic" case where re-summarizing would duplicate the
  // child's work.
  const soleOwningChild = (node, run) => {
    const runSet = new Set(run);
    const hitting = node.children.filter((c) => c.sourceSentences.some((s) => runSet.has(s)));
    if (hitting.length !== 1) return null;
    const child = hitting[0];
    const childSet = new Set(child.sourceSentences);
    return run.every((s) => childSet.has(s)) ? child : null;
  };

  // Resolve a node's per-run summaries, reusing a child's run for any run that one
  // child wholly owns. Memoized by path so a reused child resolves once even when
  // several ancestors reuse it.
  const resolving = new Map();
  const resolve = (node) => {
    if (resolving.has(node.path)) return resolving.get(node.path);
    const p = (async () => {
      if (node.children.length === 0) {
        const leaf = leafSummaries[node.path];
        return { runs: (leaf && Array.isArray(leaf.runs) && leaf.runs) || [] };
      }

      // Plan each run: reuse a sole owning child, or summarize it fresh.
      const plan = splitContiguousRuns(node.sourceSentences).map((run) => ({
        run,
        child: soleOwningChild(node, run),
      }));
      const generateRuns = plan.filter((item) => !item.child).map((item) => item.run);

      // The fresh runs go through summarizeSource in a single call over only their
      // sentences; it re-splits them into the same runs (gap-separated), keyed by
      // first sentence id for reassembly below.
      let generatedByFirst = new Map();
      if (generateRuns.length) {
        let generated;
        try {
          generated = await summarizeSource(generateRuns.flat(), { path: node.path });
        } catch (e) {
          if (onError) {
            await onError({ path: node.path, error: e });
          }
          generated = { runs: [] };
        }
        const genRuns = (generated && Array.isArray(generated.runs) && generated.runs) || [];
        generatedByFirst = new Map(genRuns.map((r) => [r.sentences[0], r]));
      }

      // Reassemble in document order: reused runs take the child's matching run
      // text; generated runs take summarizeSource's output (empty text on failure).
      const runs = [];
      for (const { run, child } of plan) {
        if (child) {
          const childSummary = await resolve(child);
          const match = ((childSummary && childSummary.runs) || []).find((r) =>
            sameSource(r.sentences, run),
          );
          runs.push({ sentences: run, text: match ? match.text : '' });
        } else {
          const g = generatedByFirst.get(run[0]);
          runs.push({ sentences: run, text: g ? g.text : '' });
        }
      }
      return { runs };
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
      runs: (node.summary && Array.isArray(node.summary.runs) && node.summary.runs) || [],
      level: node.level - 1,
      source_sentences: node.sourceSentences,
    };
  }
  return topicSummaryIndex;
}
