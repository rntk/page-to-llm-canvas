import { sortedUnique } from '../../shared/runtime/sortedUnique.js';
// Summary tree nodes: passages of source sentences (the evidence layer), topic
// nodes grouping them, and the article root. Segments link every claim either
// to sentence numbers (passages) or to child claims (topics and the root), so
// any statement resolves down to the source sentences it came from.

export const PASSAGE = 'passage';
export const TOPIC = 'topic';
export const ROOT = 'root';

export const LEVEL = Object.freeze({
  PASSAGE: 'passage',
  DETAIL: 'detail',
  OVERVIEW: 'overview',
  ROOT: 'root',
});

/**
 * @typedef {{kind: 'rows', first: number, last: number}
 *   | {kind: 'claim', child: string, segment: number}} SegmentSource
 * @typedef {{text: string, sources: SegmentSource[]}} Segment
 * @typedef {'passage'|'topic'|'root'} NodeKind
 * @typedef {'passage'|'detail'|'overview'|'root'} SummaryLevel
 */

/**
 * @typedef {object} SummaryTreeNode
 * @property {string} id
 * @property {NodeKind} kind
 * @property {string} title
 * @property {string[]} children Child node ids; empty for passages.
 * @property {number[]} sentences One-based source sentence numbers.
 * @property {string[]} path Topic titles from the root down.
 * @property {Segment[]|null} segments Null means pending; empty means skipped or failed.
 * @property {boolean} failed Whether generation exhausted its retries.
 * @property {boolean} unplaced Whether an incremental source unit needs placement.
 * @property {string} [recordKey] Source record identity for project source nodes.
 * @property {string} [topicName] Original primary topic path; preserves its title during generation.
 * @property {string} [sourceTitle] Source article title.
 * @property {string} [sourceUrl] Source article URL.
 */

/**
 * @typedef {object} NodeOptions
 * @property {number[]} [sentences] Explicit evidence rows; otherwise union the children's.
 * @property {string[]} [path] Topic titles from the root down.
 * @property {string} [recordKey] Source record identity.
 * @property {string} [topicName] Original primary topic path.
 * @property {string} [sourceTitle] Source article title.
 * @property {string} [sourceUrl] Source article URL.
 */

const TITLE_CHARS = 80;

/**
 * Collapse whitespace and trim separators; topic paths use ">" so it is replaced.
 * @param {unknown} value
 * @returns {string|null}
 */
export function cleanTitle(value) {
  if (typeof value !== 'string') return null;
  const title = value
    .replace(/[>:]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s.;:\-–—]+|[\s.;:\-–—]+$/gu, '');
  return title ? title.slice(0, TITLE_CHARS) : null;
}

/**
 * Append a node; topic and root sentences are the union of their children's.
 * @param {Record<string, SummaryTreeNode>} nodes
 * @param {NodeKind} kind
 * @param {string} title
 * @param {string[]} children
 * @param {NodeOptions} [options]
 * @returns {string} The new node id.
 */
export function addNode(
  nodes,
  kind,
  title,
  children,
  { sentences, path = [], recordKey, topicName, sourceTitle, sourceUrl } = {},
) {
  const id = `n${Object.keys(nodes).length}`;
  const own = sentences ?? sortedUnique(children.flatMap((child) => nodes[child].sentences));
  nodes[id] = {
    id,
    kind,
    title,
    children,
    sentences: own,
    path,
    segments: null,
    failed: false,
    unplaced: false,
    ...(recordKey !== undefined ? { recordKey } : {}),
    ...(topicName !== undefined ? { topicName } : {}),
    ...(sourceTitle !== undefined ? { sourceTitle } : {}),
    ...(sourceUrl !== undefined ? { sourceUrl } : {}),
  };
  return id;
}

/**
 * Append a passage with explicit evidence rows and no children.
 * @param {Record<string, SummaryTreeNode>} nodes
 * @param {string} title
 * @param {number[]} sentences
 * @param {NodeOptions} [options]
 * @returns {string} The new node id.
 */
export function createPassage(nodes, title, sentences, options = {}) {
  return addNode(nodes, PASSAGE, title, [], { ...options, sentences });
}

/**
 * Append a grouping topic over existing children.
 * @param {Record<string, SummaryTreeNode>} nodes
 * @param {string} title
 * @param {string[]} children
 * @param {NodeOptions} [options]
 * @returns {string} The new node id.
 */
export function createTopic(nodes, title, children, options = {}) {
  return addNode(nodes, TOPIC, title, children, options);
}

/**
 * Append an article or project root over existing children.
 * @param {Record<string, SummaryTreeNode>} nodes
 * @param {string} title
 * @param {string[]} children
 * @returns {string} The new node id.
 */
export function createRoot(nodes, title, children) {
  return addNode(nodes, ROOT, title, children);
}

/**
 * Reuse identical child prose only when segment positions match exactly, so
 * a single-child topic does not cost a request.
 * @param {SummaryTreeNode[]} children
 * @returns {Segment[]|null}
 */
export function relay(children) {
  const first = children[0]?.segments;
  const shape = (segments) => segments.map((s) => [s.text, s.sources.length > 0]);
  if (
    !first ||
    children.some(
      (child) =>
        !child.segments || JSON.stringify(shape(child.segments)) !== JSON.stringify(shape(first)),
    )
  ) {
    return null;
  }
  return first.map((segment, index) => ({
    text: segment.text,
    sources: segment.sources.length
      ? children.map((child) => ({ kind: 'claim', child: child.id, segment: index }))
      : [],
  }));
}

/**
 * Resolve persisted links to sentence numbers; never infer support from membership.
 * @param {SummaryTreeNode} node
 * @param {number} index Segment index.
 * @param {Record<string, SummaryTreeNode>} nodes
 * @returns {number[]}
 */
export function claimSentences(node, index, nodes) {
  const ids = new Set();
  for (const source of node.segments?.[index]?.sources || []) {
    if (source.kind === 'rows') {
      for (let id = source.first; id <= source.last; id++) ids.add(id);
    } else if (nodes[source.child]) {
      claimSentences(nodes[source.child], source.segment, nodes).forEach((id) => ids.add(id));
    }
  }
  return sortedUnique(ids);
}

/**
 * @param {SummaryTreeNode} node
 * @returns {string}
 */
export function summaryText(node) {
  return (node.segments || [])
    .map((segment) => segment.text)
    .join('')
    .trim();
}

/**
 * Ids of the nodes summarized from child claims.
 * @param {Record<string, SummaryTreeNode>} nodes
 */
export function topicIds(nodes) {
  return Object.values(nodes)
    .filter((node) => node.kind === TOPIC || node.kind === ROOT)
    .map((node) => node.id);
}

/**
 * Topic levels between the root and its passages.
 * @param {string|null} rootId
 * @param {Record<string, SummaryTreeNode>} nodes
 */
export function treeLevels(rootId, nodes) {
  const depth = (id) => {
    const node = nodes[id];
    if (!node || node.kind === PASSAGE) return 0;
    return 1 + Math.max(0, ...node.children.map(depth));
  };
  return rootId && nodes[rootId] ? depth(rootId) - 1 : 0;
}
