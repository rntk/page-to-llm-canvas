/**
 * Pure projection of a saved summary tree onto the record's primary topic shape,
 * so views built on `record.topics` and `record.topic_summary_index` (canvas,
 * hierarchy) can show the summary tree unchanged.
 *
 * Passages become the leaf topics: contiguous and non-overlapping, so each
 * source sentence belongs to exactly one leaf, as the chronological canvas
 * builder expects. Topic nodes contribute only their paths and summaries. The
 * root overview is skipped: neither view shows an article-level summary and the
 * pipeline index has no root entry.
 */

import { PASSAGE, summaryText } from '../core/pipeline/summaryTreeModel.js';
import { joinTopicPath } from '../shared/runtime/topicPath.js';
import { sortedUnique } from '../shared/runtime/sortedUnique.js';
import { splitSentenceRuns } from './topicDomain.js';

// Topic paths use ">"; saved titles are already cleaned, this guards older data.
function pathTitle(value) {
  return typeof value === 'string' ? value.replace(/>/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
}

// Saved summary tree sentences and record topic sentences are both one-based.
function sentencesOf(node) {
  return sortedUnique(
    (Array.isArray(node?.sentences) ? node.sentences : []).filter(
      (value) => Number.isInteger(value) && value > 0,
    ),
  );
}

function fallbackTitle(sentences) {
  if (!sentences.length) return 'Untitled';
  const first = sentences[0];
  const last = sentences.at(-1);
  return first === last ? `Sentence ${first}` : `Sentences ${first}–${last}`;
}

// Sibling titles stay unique so every node keeps its own path.
function uniqueTitle(title, taken) {
  let candidate = title;
  for (let count = 2; taken.has(candidate); count += 1) candidate = `${title} (${count})`;
  taken.add(candidate);
  return candidate;
}

/**
 * Index entry in the pipeline's shape. A topic recurring in several stretches
 * gets one run per stretch, as the pipeline writes. A summary tree node has one
 * summary for all its stretches, so every run carries it and each occurrence on
 * the canvas rail and in summary mode shows it. Views that join run texts
 * collapse repeats.
 * @param {object} node Summary tree node.
 * @param {number[]} sentences The node's one-based sentence numbers.
 * @param {number} level Zero-based topic level.
 */
function indexEntry(node, sentences, level) {
  const text = summaryText(node);
  const failed = node.failed === true;
  return {
    runs: splitSentenceRuns(sentences).map((run) => ({
      sentences: run,
      text,
      ...(failed ? { error: true } : {}),
    })),
    level,
    source_sentences: sentences,
  };
}

/**
 * Convert a saved summary tree into `{topics, topic_summary_index}` as stored
 * on a record. Pending or failed nodes keep their place with empty summaries.
 *
 * @param {{rootId?: string, nodes?: Record<string, object>}|null|undefined} summaryTree
 * @returns {{topics: Array<{name: string, sentences: number[]}>,
 *   topic_summary_index: Record<string, {runs: Array<{sentences: number[], text: string}>,
 *   level: number, source_sentences: number[]}>}|null} Null until the tree has a root
 *   with at least one leaf topic.
 */
export function projectSummaryTreeTopics(summaryTree) {
  const nodes = summaryTree?.nodes;
  const root = nodes && typeof nodes === 'object' ? nodes[summaryTree.rootId] : null;
  if (!root) return null;

  const topics = [];
  const index = {};
  const assigned = new Set();
  const visited = new Set([root.id ?? summaryTree.rootId]);

  const childrenOf = (node) =>
    node.kind === PASSAGE
      ? []
      : (Array.isArray(node.children) ? node.children : [])
          .filter((id) => !visited.has(id) && nodes[id])
          .map((id) => {
            visited.add(id);
            return nodes[id];
          });

  const visit = (node, parts) => {
    const sentences = sentencesOf(node);
    const children = childrenOf(node);
    const path = joinTopicPath(parts);
    const level = parts.length - 1;
    if (children.length) {
      // Written before the children so the index keeps tree order; dropped
      // when no leaf below survives, so every entry names a shown topic.
      const before = topics.length;
      if (sentences.length) index[path] = indexEntry(node, sentences, level);
      visitChildren(children, parts);
      if (topics.length === before) delete index[path];
      return;
    }
    // Leaves own their sentences once; a repeated sentence keeps its first leaf.
    const own = sentences.filter((sentence) => !assigned.has(sentence));
    if (!own.length) return;
    own.forEach((sentence) => assigned.add(sentence));
    index[path] = indexEntry(node, own, level);
    topics.push({ name: path, sentences: own });
  };

  const visitChildren = (children, parts) => {
    const taken = new Set();
    for (const child of children) {
      const title = pathTitle(child.title) || fallbackTitle(sentencesOf(child));
      visit(child, [...parts, uniqueTitle(title, taken)]);
    }
  };

  visitChildren(childrenOf(root), []);
  return topics.length ? { topics, topic_summary_index: index } : null;
}
