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

// A passage is the unit a brief summary is written for. Passages prefer the
// primary split's topic boundaries, so one passage rarely mixes subjects.
export const PASSAGE_TARGET_CHARS = 1500;
export const PASSAGE_MIN_CHARS = 400;
export const PASSAGE_MAX_CHARS = 3000;

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

function charsOf(sentenceIds, sentenceTexts) {
  return sentenceIds.reduce((sum, id) => sum + String(sentenceTexts[id - 1] || '').length + 1, 0);
}

// Near-equal character parts at sentence boundaries.
function splitRun(run, sentenceTexts, targetChars) {
  const total = charsOf(run, sentenceTexts);
  const count = Math.ceil(total / targetChars);
  if (count <= 1) return [run];
  const share = total / count;
  const parts = [[]];
  let size = 0;
  for (const id of run) {
    const chars = charsOf([id], sentenceTexts);
    if (parts.at(-1).length && size + chars / 2 > share * parts.length && parts.length < count) {
      parts.push([]);
    }
    parts.at(-1).push(id);
    size += chars;
  }
  return parts;
}

/**
 * Cut the article into contiguous passages of nonblank sentences. Cuts prefer
 * the primary topics' boundaries; long runs are split evenly and short pieces
 * join a neighbour.
 * @param {string[]} sentenceTexts Sentences by one-based number.
 * @param {Array<{name: string, sentences: number[]}>} [topics] Primary topics.
 * @param {object} [options]
 * @param {number} [options.targetChars]
 * @param {number} [options.minChars]
 * @param {number} [options.maxChars]
 * @returns {number[][]} One-based sentence numbers per passage, in article order.
 */
export function buildPassages(
  sentenceTexts,
  topics = [],
  {
    targetChars = PASSAGE_TARGET_CHARS,
    minChars = PASSAGE_MIN_CHARS,
    maxChars = PASSAGE_MAX_CHARS,
  } = {},
) {
  const topicOf = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    for (const id of Array.isArray(topic?.sentences) ? topic.sentences : []) {
      topicOf.set(id, topic.name);
    }
  }
  const runs = [];
  let previous;
  sentenceTexts.forEach((text, index) => {
    const id = index + 1;
    if (typeof text !== 'string' || !text.trim()) return;
    const topic = topicOf.get(id);
    if (!runs.length || topic !== previous) runs.push([]);
    runs.at(-1).push(id);
    previous = topic;
  });
  const pieces = runs.flatMap((run) =>
    charsOf(run, sentenceTexts) > maxChars ? splitRun(run, sentenceTexts, targetChars) : [run],
  );
  const passages = [];
  for (const piece of pieces) {
    const current = passages.at(-1);
    const currentChars = current ? charsOf(current, sentenceTexts) : 0;
    const pieceChars = charsOf(piece, sentenceTexts);
    if (
      current &&
      (currentChars < minChars || pieceChars < minChars) &&
      currentChars + pieceChars <= maxChars
    ) {
      current.push(...piece);
    } else {
      passages.push([...piece]);
    }
  }
  return passages;
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
  const own =
    sentences ??
    [...new Set(children.flatMap((child) => nodes[child].sentences))].sort((a, b) => a - b);
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
  return [...ids].sort((a, b) => a - b);
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
