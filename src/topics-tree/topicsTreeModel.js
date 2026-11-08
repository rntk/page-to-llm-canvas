import { buildTopicTree } from '../domain/topicTree.js';
import { getTopicSentenceNumbers } from '../domain/topicDomain.js';
import { buildSummaryLookup } from '../hierarchy/hierarchyUtils.js';
import { joinTopicPath } from '../shared/runtime/topicPath.js';

// Topics tree view model: saved topics + summaries -> collapsible display tree.
// Pure functions only, so they run without a DOM.

export const ROOT_KIND = 'root';
export const TOPIC_KIND = 'topic';
export const LEAF_KIND = 'leaf';

export const ROOT_KEY = 'root';

const topicKey = (fullPath) => `topic:${fullPath}`;

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

  const visit = (entry) => {
    const { node } = entry;
    const children = Array.from(entry.children.values(), visit);
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
        sentences: [...new Set(ownSentences)].sort((a, b) => a - b),
        children: [],
      });
    return {
      key: topicKey(node.fullPath),
      kind: TOPIC_KIND,
      title: node.name,
      path: node.fullPath,
      depth: node.depth + 1,
      summary: summaries.get(node.fullPath) || '',
      sentences: Array.from(sentences).sort((a, b) => a - b),
      children,
    };
  };

  const children = roots.map(visit);
  const sentences = new Set(children.flatMap((child) => child.sentences));
  return {
    key: ROOT_KEY,
    kind: ROOT_KIND,
    title,
    path: '',
    depth: 0,
    summary: '',
    sentences: Array.from(sentences).sort((a, b) => a - b),
    children,
  };
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
  const text = (node) =>
    (Array.isArray(node.segments) ? node.segments : [])
      .map((segment) => segment?.text || '')
      .join('')
      .trim();
  const sorted = (sentences) =>
    [...new Set(Array.isArray(sentences) ? sentences : [])].sort((a, b) => a - b);

  const visit = (node, titles) => {
    const children = (node.kind === 'passage' ? [] : node.children)
      .map((id) => nodes[id])
      .filter(Boolean)
      .map((child) => visit(child, [...titles, child.title]));
    if (node.kind === 'passage' && sorted(node.sentences).length)
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
      summary: text(node),
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
  return { ...visit(root, []), key: ROOT_KEY, kind: ROOT_KIND, title };
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

/**
 * Start with the root open, so the top-level topics are visible.
 * @param {object|null} tree Display tree.
 */
export function initialExpanded(tree) {
  return tree ? new Set([tree.key]) : new Set();
}

/**
 * @param {object|null} tree Display tree.
 * @param {string} key Display node key.
 * @returns {object[]} chain of display nodes from the root to the node with `key`
 */
export function pathTo(tree, key) {
  if (!tree) return [];
  if (tree.key === key) return [tree];
  for (const child of tree.children) {
    const path = pathTo(child, key);
    if (path.length) return [tree, ...path];
  }
  return [];
}

function collapseSubtree(node, expanded) {
  if (!node) return;
  expanded.delete(node.key);
  node.children.forEach((child) => collapseSubtree(child, expanded));
}

/**
 * Toggle a node; with `exclusive` opening a node closes its siblings
 * (and their descendants) so only one branch is walked at a time.
 * @param {object} tree
 * @param {Set<string>} expanded
 * @param {string} key
 * @param {boolean} [exclusive]
 * @returns {Set<string>}
 */
export function toggleNode(tree, expanded, key, exclusive = false) {
  const next = new Set(expanded);
  const path = pathTo(tree, key);
  const node = path.at(-1);
  if (!node || !node.children.length) return next;
  if (next.has(key)) {
    collapseSubtree(node, next);
    return next;
  }
  if (exclusive && path.length > 1) {
    for (const sibling of path.at(-2).children) {
      if (sibling.key !== key) collapseSubtree(sibling, next);
    }
  }
  path.forEach((ancestor) => next.add(ancestor.key));
  return next;
}

/**
 * Number of levels in the tree, the root being level 1 (a lone root is 1).
 * @param {object|null} tree Display tree.
 */
export function treeDepth(tree) {
  if (!tree) return 0;
  return 1 + Math.max(0, ...tree.children.map(treeDepth));
}

/**
 * Keys to expand so that exactly `level` levels are visible (root = level 1).
 * @param {object|null} tree Display tree.
 * @param {number} level Number of visible levels.
 * @returns {Set<string>}
 */
export function expandToLevel(tree, level) {
  const keys = new Set();
  const walk = (node, depth) => {
    if (node.children.length && depth + 1 < level) {
      keys.add(node.key);
      node.children.forEach((child) => walk(child, depth + 1));
    }
  };
  if (tree) walk(tree, 0);
  return keys;
}

/**
 * The level whose expansion equals `expanded` exactly, or null for a custom state.
 * @param {object|null} tree Display tree.
 * @param {Set<string>} expanded Keys of the open nodes.
 */
export function currentLevel(tree, expanded) {
  for (let level = 1; level <= treeDepth(tree); level += 1) {
    const keys = expandToLevel(tree, level);
    if (keys.size === expanded.size && [...keys].every((key) => expanded.has(key))) {
      return level;
    }
  }
  return null;
}

/**
 * Expand every ancestor of `key` so it becomes visible.
 * @param {object|null} tree Display tree.
 * @param {Set<string>} expanded Keys of the open nodes.
 * @param {string} key Display node key.
 */
export function revealNode(tree, expanded, key) {
  const next = new Set(expanded);
  pathTo(tree, key)
    .slice(0, -1)
    .forEach((node) => next.add(node.key));
  return next;
}

/**
 * Expand `key` and everything below it, down to the leaf cards.
 * @param {object|null} tree Display tree.
 * @param {Set<string>} expanded Keys of the open nodes.
 * @param {string} key Display node key.
 */
export function expandBranch(tree, expanded, key) {
  const next = revealNode(tree, expanded, key);
  const walk = (node) => {
    if (!node.children.length) return;
    next.add(node.key);
    node.children.forEach(walk);
  };
  const start = pathTo(tree, key).at(-1);
  if (start) walk(start);
  return next;
}

/**
 * Every branch key, i.e. the fully expanded state.
 * @param {object|null} tree Display tree.
 */
export function expandAll(tree) {
  return tree ? expandBranch(tree, new Set(), tree.key) : new Set();
}

/**
 * Copy of the tree keeping only children of expanded nodes.
 * @param {object|null} tree Display tree.
 * @param {Set<string>} expanded Keys of the open nodes.
 */
export function visibleTree(tree, expanded) {
  if (!tree) return null;
  const open = expanded.has(tree.key);
  return {
    ...tree,
    hiddenCount: open ? 0 : tree.children.length,
    children: open ? tree.children.map((child) => visibleTree(child, expanded)) : [],
  };
}

/**
 * Pre-order list of the nodes in a (visible) tree.
 * @param {object|null} tree Display tree.
 */
export function flattenTree(tree) {
  if (!tree) return [];
  return [tree, ...tree.children.flatMap(flattenTree)];
}

/**
 * Font size grows with the share of the article a topic covers, like a word tree.
 * @param {object} node Display node.
 * @param {number} totalSentences Sentences covered by the whole tree.
 */
export function labelSize(node, totalSentences) {
  if (node.kind === LEAF_KIND) return 14;
  const share = totalSentences > 0 ? node.sentences.length / totalSentences : 0;
  return Math.round(15 + 21 * Math.sqrt(Math.min(1, share)));
}

/**
 * Wrap width for a topic label: bigger type gets a wider line, within sane bounds.
 * @param {number} fontSize Title font size in px.
 */
export function topicMaxWidth(fontSize) {
  return Math.max(420, Math.min(680, Math.round(fontSize * 20)));
}
