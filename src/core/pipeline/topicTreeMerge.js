// Build per-run topic summaries. A run owned by one child reuses that child's
// summary; mixed or node-owned text is summarized from source to retain detail.
// Resolution is memoized by path, and the empty root is excluded from the index.

import { hasSummaryRunMarker, isFailedSummaryRun, publicSummaryRun } from './summaryRunMarkers.js';
import { TOPIC_PATH_DELIMITER, isCanonicalDescendantPath } from '../../shared/runtime/topicPath.js';

/**
 * Builds the worker's summary tree from flat hierarchical topic paths and
 * aggregates descendant sentence ids onto every parent node.
 *
 * @param {Array<{name: string, sentences: number[]}>} topics
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
    // Preserve empty path segments so malformed paths fail the shrink guard.
    const parts = path.split(TOPIC_PATH_DELIMITER);
    const parentPath = parts.slice(0, -1).join(TOPIC_PATH_DELIMITER);
    // Malformed derivations must fail before unbounded recursion.
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
    if (!topic.name) continue;
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
 * Split sorted 1-based sentence ids into contiguous, separately summarized runs.
 *
 * @param {number[]} sentenceIds
 * @returns {number[][]} ordered runs of consecutive ids
 */
export function splitContiguousRuns(sentenceIds) {
  const sorted = Array.isArray(sentenceIds)
    ? Array.from(new Set(sentenceIds)).sort((a, b) => a - b)
    : [];
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

// Two sorted sentence-id lists cover the same source iff they are equal.
function sameSource(a, b) {
  return (
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
  );
}

/** Sentences whose leaf summary carries an error or failure marker. An
 * unmarked empty summary is valid and does not invalidate ancestor work.
 * @param {Record<string, object>} leafSummaries
 * @returns {Set<number>}
 */
function collectUnusableLeafSentences(leafSummaries) {
  const unusable = new Set();
  for (const summary of Object.values(leafSummaries || {})) {
    if (!summary || typeof summary !== 'object') continue;
    if (summary.error === true) {
      // A topic-level error can cover runs that were never attempted, so the
      // whole leaf source is suspect, not only the marked runs.
      for (const sentence of Array.isArray(summary.source_sentences)
        ? summary.source_sentences
        : []) {
        unusable.add(sentence);
      }
    }
    for (const run of Array.isArray(summary.runs) ? summary.runs : []) {
      if (!run || !Array.isArray(run.sentences)) continue;
      if (hasSummaryRunMarker(run)) {
        for (const sentence of run.sentences) unusable.add(sentence);
      }
    }
  }
  return unusable;
}

/**
 * Project available summaries before parents resolve. Reuse prior runs only
 * when their source still matches and no failed descendant overlaps them.
 * Current leaf checkpoints take precedence over prior aggregated entries;
 * failed markers remain visible for retry dependency checks.
 *
 * @param {Array<{name: string, sentences: number[]}>} topics
 * @param {Record<string, {runs: Array<{sentences: number[], text: string}>, source_sentences: number[]}>} leafSummaries
 * @param {Record<string, {runs: Array<{sentences: number[], text: string}>}>} [previousSummaryIndex]
 * @returns {Record<string, {runs: Array<{sentences: number[], text: string}>, level: number, source_sentences: number[]}>}
 */
export function buildPartialTopicSummaryIndex(topics, leafSummaries, previousSummaryIndex = {}) {
  const { nodes } = buildTopicTree(topics);
  const index = {};
  for (const [path, summary] of Object.entries(leafSummaries)) {
    const node = nodes.get(path);
    if (!node || !summary || typeof summary !== 'object') continue;
    index[path] = {
      runs: publicRuns(summary.runs),
      level: node.level - 1,
      source_sentences: Array.isArray(summary.source_sentences)
        ? summary.source_sentences
        : node.sourceSentences,
    };
  }

  if (!previousSummaryIndex || typeof previousSummaryIndex !== 'object') return index;
  const unusableSentences = collectUnusableLeafSentences(leafSummaries);
  // A failed internal run also invalidates overlapping ancestor runs.
  const priorFailedRunsByPath = new Map();
  for (const [path, prior] of Object.entries(previousSummaryIndex)) {
    const failedRuns = (Array.isArray(prior?.runs) ? prior.runs : [])
      .filter((run) => run && Array.isArray(run.sentences) && run.sentences.length > 0)
      .filter(isFailedSummaryRun)
      .map((run) => run.sentences);
    if (failedRuns.length > 0) priorFailedRunsByPath.set(path, failedRuns);
  }
  const hasPriorFailedDependency = (path, run) => {
    const source = new Set(run);
    for (const [failedPath, failedRuns] of priorFailedRunsByPath) {
      if (failedPath !== path && !isCanonicalDescendantPath(failedPath, path)) continue;
      if (failedRuns.some((failed) => failed.some((sentence) => source.has(sentence)))) return true;
    }
    return false;
  };

  for (const [path, prior] of Object.entries(previousSummaryIndex)) {
    // A leaf checkpoint from this run is authoritative for its own path.
    if (index[path] || !prior || !Array.isArray(prior.runs)) continue;
    const node = nodes.get(path);
    if (!node || node.children.length === 0) continue;
    const priorByFirst = new Map();
    for (const run of prior.runs) {
      if (run && Array.isArray(run.sentences) && run.sentences.length > 0) {
        priorByFirst.set(run.sentences[0], run);
      }
    }
    let kept = 0;
    const runs = splitContiguousRuns(node.sourceSentences).map((run) => {
      const priorRun = priorByFirst.get(run[0]);
      if (!priorRun || !sameSource(priorRun.sentences, run)) return { sentences: run, text: '' };
      if (hasSummaryRunMarker(priorRun)) {
        // Retry needs this marker to invalidate overlapping ancestors.
        kept += 1;
        return { ...publicSummaryRun(priorRun), sentences: run, text: '' };
      }
      const usable =
        typeof priorRun.text === 'string' &&
        priorRun.text !== '' &&
        !run.some((sentence) => unusableSentences.has(sentence)) &&
        !hasPriorFailedDependency(path, run);
      if (!usable) return { sentences: run, text: '' };
      kept += 1;
      return { sentences: run, text: priorRun.text };
    });
    if (kept === 0) continue;
    index[path] = { runs, level: node.level - 1, source_sentences: node.sourceSentences };
  }
  return index;
}

function publicRuns(runs) {
  return (Array.isArray(runs) ? runs : []).map(publicSummaryRun);
}

/**
 * Each summary is a list of per-run entries ({sentences, text}), one per
 * contiguous occurrence of the topic, rather than a single text blob.
 *
 * @param {object} params
 * @param {Map<string, {path: string, level: number, children: Array<object>, sourceSentences: number[], summary: object}>} params.nodes
 * @param {Record<string, {runs: Array<{sentences: number[], text: string}>}>} params.leafSummaries  keyed by topic path
 * @param {Record<string, object>} [params.previousSummaryIndex] Prior tree
 *   projection. Structurally valid successful paths are reused on normal
 *   Retry, while failed/missing paths are regenerated.
 * @param {boolean} [params.reusePriorSummaries] Enable per-path reuse.
 * @param {function(number[], {path: string}): Promise<{runs: Array<{sentences: number[], text: string}>}>} params.summarizeSource
 * @param {function({path: string, error: unknown}): (void | Promise<void>)} [params.onError]
 *   Called with a node's summarization failure. Returning normally degrades that
 *   node to empty runs and resolution continues; throwing (or rejecting)
 *   propagates and aborts the whole tree, which is how a caller escalates an
 *   error that a retry could never fix.
 * @returns {Promise<Record<string, {runs: Array<{sentences: number[], text: string}>, level: number, source_sentences: number[]}>>}
 */
export async function summarizeTopicTree({
  nodes,
  leafSummaries,
  summarizeSource,
  onError,
  previousSummaryIndex = {},
  reusePriorSummaries = false,
}) {
  const summarizable = [...nodes.values()].filter((node) => node.path);

  // Delegate only runs wholly owned by one child.
  const soleOwningChild = (node, run) => {
    const runSet = new Set(run);
    const hitting = node.children.filter((c) => c.sourceSentences.some((s) => runSet.has(s)));
    if (hitting.length !== 1) return null;
    const child = hitting[0];
    const childSet = new Set(child.sourceSentences);
    return run.every((s) => childSet.has(s)) ? child : null;
  };

  // Failure markers are scoped to the source run that failed.
  const priorFailedRunsByPath = new Map();
  const priorRunsByPath = new Map();
  if (reusePriorSummaries && previousSummaryIndex && typeof previousSummaryIndex === 'object') {
    for (const [path, prior] of Object.entries(previousSummaryIndex)) {
      if (!prior || !Array.isArray(prior.runs)) continue;
      const byFirst = new Map();
      const failedRuns = [];
      for (const run of prior.runs) {
        if (run && Array.isArray(run.sentences) && typeof run.text === 'string') {
          byFirst.set(run.sentences[0], run);
          if (isFailedSummaryRun(run) && run.sentences.length > 0) failedRuns.push(run.sentences);
        }
      }
      if (failedRuns.length > 0) priorFailedRunsByPath.set(path, failedRuns);
      priorRunsByPath.set(path, byFirst);
    }
  }

  const overlaps = (a, b) => {
    const source = new Set(Array.isArray(a) ? a : []);
    return Array.isArray(b) && b.some((sentence) => source.has(sentence));
  };

  const failedLeafRunsByPath = new Map();
  for (const [path, leaf] of Object.entries(leafSummaries || {})) {
    const failedRuns = (Array.isArray(leaf?.runs) ? leaf.runs : [])
      .filter(
        (run) =>
          run &&
          Array.isArray(run.sentences) &&
          run.sentences.length > 0 &&
          // Accepted leaf failures still invalidate overlapping ancestors.
          hasSummaryRunMarker(run),
      )
      .map((run) => run.sentences);
    if (failedRuns.length > 0) failedLeafRunsByPath.set(path, failedRuns);
  }

  const isDescendantOrSelf = (candidate, path) =>
    candidate === path || isCanonicalDescendantPath(candidate, path);
  const mapHasFailedDependency = (mapByPath, path, valueMatches) => {
    for (const [failedPath, value] of mapByPath) {
      if (isDescendantOrSelf(failedPath, path) && valueMatches(value)) {
        return true;
      }
    }
    return false;
  };
  const runsMapHasFailedDependency = (runsByPath, path, run) =>
    mapHasFailedDependency(runsByPath, path, (failedRuns) =>
      failedRuns.some((failed) => overlaps(run, failed)),
    );
  const hasFailedDependency = (path, run) =>
    runsMapHasFailedDependency(failedLeafRunsByPath, path, run) ||
    runsMapHasFailedDependency(priorFailedRunsByPath, path, run);

  // Memoize by path so shared children resolve once.
  const resolving = new Map();
  const resolve = (node) => {
    if (resolving.has(node.path)) return resolving.get(node.path);
    const p = (async () => {
      if (node.children.length === 0) {
        const leaf = leafSummaries[node.path];
        return { runs: (leaf && Array.isArray(leaf.runs) && leaf.runs) || [] };
      }

      // A failed descendant invalidates even a structurally matching prior run.
      const priorRuns = priorRunsByPath.get(node.path);
      const plan = splitContiguousRuns(node.sourceSentences).map((run) => {
        const child = soleOwningChild(node, run);
        const prior = priorRuns?.get(run[0]);
        const priorMatches =
          reusePriorSummaries &&
          prior &&
          Array.isArray(prior.sentences) &&
          sameSource(prior.sentences, run) &&
          typeof prior.text === 'string' &&
          prior.text !== '' &&
          !priorFailedRunsByPath.get(node.path)?.some((failed) => overlaps(run, failed)) &&
          !hasFailedDependency(node.path, run);
        return { run, child, prior: priorMatches ? prior : null };
      });
      const generateRuns = plan
        .filter((item) => !item.child && !item.prior)
        .map((item) => item.run);

      // Source summarization re-splits these gap-separated runs for reassembly.
      let generatedByFirst = new Map();
      let generationFailed = false;
      if (generateRuns.length) {
        let generated;
        try {
          generated = await summarizeSource(generateRuns.flat(), { path: node.path });
        } catch (e) {
          generationFailed = true;
          if (onError) {
            await onError({ path: node.path, error: e });
          }
          generated = { runs: [] };
        }
        const genRuns = (generated && Array.isArray(generated.runs) && generated.runs) || [];
        generatedByFirst = new Map(genRuns.map((r) => [r.sentences[0], r]));
      }

      const runs = [];
      for (const { run, child, prior } of plan) {
        if (prior) {
          runs.push({ sentences: run, text: prior.text });
          continue;
        }
        if (child) {
          const childSummary = await resolve(child);
          const match = ((childSummary && childSummary.runs) || []).find((r) =>
            sameSource(r.sentences, run),
          );
          runs.push({ sentences: run, text: match ? match.text : '' });
        } else {
          const g = generatedByFirst.get(run[0]);
          runs.push({
            sentences: run,
            text: g ? g.text : '',
            ...(generationFailed ? { error: true } : {}),
          });
        }
      }
      return { runs };
    })();
    resolving.set(node.path, p);
    return p;
  };

  await Promise.all(
    summarizable.map(async (node) => {
      // Each callback owns a distinct node's summary.
      // eslint-disable-next-line require-atomic-updates
      node.summary = await resolve(node);
    }),
  );

  const topicSummaryIndex = {};
  for (const [path, node] of nodes) {
    if (!path) continue;
    topicSummaryIndex[path] = {
      runs: publicRuns(node.summary && node.summary.runs),
      level: node.level - 1,
      source_sentences: node.sourceSentences,
    };
  }
  return topicSummaryIndex;
}
