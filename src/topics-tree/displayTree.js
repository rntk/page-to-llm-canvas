import { PASSAGE, summaryText } from '../core/pipeline/summaryTreeModel.js';
import { buildTopicTree } from '../domain/topicTree.js';
import { getTopicSentenceNumbers } from '../domain/topicDomain.js';
import { buildSummaryLookup } from '../hierarchy/hierarchyUtils.js';
import { joinTopicPath } from '../shared/runtime/topicPath.js';
import { sortedUnique } from '../shared/runtime/sortedUnique.js';

// Topics tree display tree: saved topics + summaries -> display nodes.
// Pure functions only, so they run without a DOM.

export const ROOT_KIND = 'root';
export const TOPIC_KIND = 'topic';
export const LEAF_KIND = 'leaf';

export const ROOT_KEY = 'root';

const topicKey = (fullPath) => `topic:${fullPath}`;

/**
 * Expanded-set key meaning "this node shows its whole source text" in place of
 * its child branches.
 * @param {string} nodeKey Display node key.
 */
export const textKey = (nodeKey) => `text:${nodeKey}`;

function leavesOf(node) {
  return node.kind === LEAF_KIND ? [node] : node.children.flatMap(leavesOf);
}

/**
 * Give every branch with sub-topics a `textCard`: one source block holding the
 * text of all its leaf cards, one section per leaf so topics stay apart. A
 * branch whose only child is its own source card has no use for one.
 * @param {object} tree Display tree (mutated).
 * @returns {object} The same tree.
 */
function attachTextCards(tree) {
  const visit = (node) => {
    if (node.kind === LEAF_KIND) return;
    node.children.forEach(visit);
    if (!node.children.some((child) => child.kind !== LEAF_KIND)) return;
    const sections = leavesOf(node).map((leaf) => ({
      key: leaf.key,
      path: leaf.path,
      sentences: leaf.sentences,
    }));
    if (!sections.length) return;
    node.textCard = {
      key: textKey(node.key),
      kind: LEAF_KIND,
      title: 'Source text',
      path: node.path,
      depth: node.depth + 1,
      summary: '',
      sentences: node.sentences,
      sections,
      children: [],
    };
  };
  visit(tree);
  return tree;
}

function sameParentSummary(summary, parentSummary, onlyChild) {
  return Boolean(
    onlyChild &&
    summary.trim() &&
    summary.trim().replace(/\s+/g, ' ') === parentSummary.trim().replace(/\s+/g, ' '),
  );
}

/**
 * Build the display tree: a virtual article root, branch topics as children,
 * and the deepest topics as leaf cards. It is built on the aggregated
 * `buildTopicTree` (one node per unique path), like the hierarchy view.
 *
 * Every display node: { key, kind, title, path, depth, summary, sentences, children }.
 * `depth` is the tree depth (root = 0, top-level topics = 1); `sentences` is the
 * sorted union of the node's own and its descendants' source sentence numbers.
 *
 * @param {Array<{name: string, sentences: number[]}>} topics
 * @param {object|null} topicSummaryIndex
 * @param {{title?: string}} [options]
 * @returns {object|null}
 */
export function buildTopicsDisplayTree(topics, topicSummaryIndex, { title = '' } = {}) {
  const roots = buildTopicTree(topics, 0);
  if (!roots.length) return null;
  const summaries = buildSummaryLookup(topicSummaryIndex);

  const visit = (entry, parent = null) => {
    const { node } = entry;
    const children = Array.from(entry.children.values(), (child) => visit(child, entry));
    const sentences = new Set(node.topic ? getTopicSentenceNumbers(node.topic) : []);
    children.forEach((child) => child.sentences.forEach((n) => sentences.add(n)));
    const ownSentences = node.topic ? getTopicSentenceNumbers(node.topic) : [];
    if (ownSentences.length)
      children.push({
        key: `source:${node.fullPath}`,
        kind: LEAF_KIND,
        title: 'Source',
        path: node.fullPath,
        depth: node.depth + 2,
        summary: '',
        sentences: sortedUnique(ownSentences),
        children: [],
      });
    return {
      key: topicKey(node.fullPath),
      kind: TOPIC_KIND,
      title: node.name,
      path: node.fullPath,
      depth: node.depth + 1,
      summary: summaries.get(node.fullPath) || '',
      summarySameAsParent: sameParentSummary(
        summaries.get(node.fullPath) || '',
        summaries.get(parent?.node.fullPath) || '',
        parent?.children.size === 1 && !getTopicSentenceNumbers(parent.node.topic).length,
      ),
      sentences: sortedUnique(sentences),
      children,
    };
  };

  const children = roots.map((entry) => visit(entry));
  const sentences = new Set(children.flatMap((child) => child.sentences));
  return attachTextCards({
    key: ROOT_KEY,
    kind: ROOT_KIND,
    title,
    path: '',
    depth: 0,
    summary: '',
    sentences: sortedUnique(sentences),
    children,
  });
}

/**
 * Build the display tree of a saved summary tree: its root overview, topic
 * nodes with their summaries, and passages as leaf cards. Unlike the pipeline
 * tree it keeps the saved structure as is, since passages under one topic may
 * share a title. Returns null until the topic structure exists.
 *
 * @param {object|null} summaryTree Saved `summary_tree`.
 * @param {{title?: string}} [options]
 * @returns {object|null}
 */
export function buildSummaryTreeDisplayTree(summaryTree, { title = '' } = {}) {
  const nodes = summaryTree?.nodes;
  const root = nodes?.[summaryTree?.rootId];
  if (!root) return null;
  const sorted = (sentences) => sortedUnique(Array.isArray(sentences) ? sentences : []);

  const visit = (node, titles, parent = null) => {
    const children = (node.kind === PASSAGE ? [] : node.children)
      .map((id) => nodes[id])
      .filter(Boolean)
      .map((child) => visit(child, [...titles, child.title], node));
    if (node.kind === PASSAGE && sorted(node.sentences).length)
      children.push({
        key: `source:${node.id}`,
        kind: LEAF_KIND,
        title: 'Source',
        path: joinTopicPath(titles),
        depth: titles.length + 1,
        summary: '',
        sentences: sorted(node.sentences),
        children: [],
      });
    return {
      key: `summary:${node.id}`,
      kind: TOPIC_KIND,
      title: node.title,
      path: joinTopicPath(titles),
      depth: titles.length,
      summary: summaryText(node),
      // Only suppress a copy along a single-child edge, never a distinct summary.
      summarySameAsParent: sameParentSummary(
        summaryText(node),
        parent ? summaryText(parent) : '',
        parent?.children?.length === 1,
      ),
      sentences: sorted(node.sentences),
      ...(summaryTree.sources
        ? {
            sourceCount: new Set(
              sorted(node.sentences)
                .map((number) => summaryTree.sources[number]?.recordKey)
                .filter(Boolean),
            ).size,
          }
        : {}),
      children,
    };
  };
  return attachTextCards({ ...visit(root, []), key: ROOT_KEY, kind: ROOT_KIND, title });
}

/**
 * Identity of one quoted passage on a source card. A block can quote the same
 * sentence under several sub-topics, so the section is part of the identity.
 * @param {string} sectionKey Key of the block section, or '' on a single card.
 * @param {number} number Tree sentence number.
 * @returns {string}
 */
export function passageKey(sectionKey, number) {
  return `${sectionKey}\u0000${number}`;
}

/**
 * Group synthetic project sentence numbers by article, retaining each article's
 * own line numbers. A missing mapping is kept separate from attributed text.
 * @param {number[]} sentenceNumbers Global, one-based sentence numbers.
 * @param {object|null} [sources] Global sentence number to source identity/local line.
 * @returns {Array<{id: string, source: object|null, sentences: object[]}>}
 */
export function groupSentenceSources(sentenceNumbers, sources) {
  const groups = new Map();
  for (const number of sentenceNumbers) {
    const source = sources ? sources[number] || { title: 'Unknown source' } : null;
    const id = source ? source.recordKey || source.url || 'unknown' : 'article';
    if (!groups.has(id)) groups.set(id, { id, source, sentences: [] });
    groups.get(id).sentences.push({
      number,
      sourceNumber: source
        ? Number.isInteger(source.sentenceId)
          ? source.sentenceId
          : null
        : number,
    });
  }
  return [...groups.values()];
}

/**
 * Label for the tree's root node: the article's host, as records carry no title.
 * @param {string} [sourceUrl] Record source URL.
 * @returns {string}
 */
export function articleRootTitle(sourceUrl) {
  try {
    return new URL(sourceUrl).hostname || 'Article';
  } catch (_) {
    return 'Article';
  }
}
