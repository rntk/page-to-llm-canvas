import { splitTopicPath } from '../domain/topicDomain.js';

/**
 * Build a nested tree from a flat list of topics whose `name` encodes a
 * hierarchy path ("A > B > C"). Returns an array of root tree entries.
 *
 * Each entry: { node, children: Map<string, entry>, parent, leafCount }
 * node: { name, fullPath, uid, depth, topic }
 * `fullPath` joins parts with ">" (no spaces) to match color helpers.
 *
 * This builds the UI's navigation tree (topic hierarchy for browsing/expanding
 * in the rail/hierarchy views). See ../../worker/pipeline/topicTreeMerge.js for the
 * worker's separate tree builder, which merges topic summaries during
 * extraction and has different structural requirements — the two are not
 * merged on purpose.
 *
 * @param {Array<{name: string, sentences: number[]}>} topics
 * @param {number} [startDepth]
 */
export function buildTopicTree(topics, startDepth = 0) {
  const roots = new Map();

  for (const topic of Array.isArray(topics) ? topics : []) {
    const parts = splitTopicPath(topic?.name);
    if (parts.length <= startDepth) continue;

    let level = roots;
    let parent = null;
    for (let i = startDepth; i < parts.length; i += 1) {
      const name = parts[i];
      const fullPath = parts.slice(0, i + 1).join('>');
      let entry = level.get(name);
      if (!entry) {
        entry = {
          node: { name, fullPath, uid: fullPath, depth: i, topic: null },
          children: new Map(),
          parent,
        };
        level.set(name, entry);
      }
      if (i === parts.length - 1) {
        entry.node.topic = topic;
      }
      parent = entry;
      level = entry.children;
    }
  }

  const rootEntries = Array.from(roots.values());
  rootEntries.forEach(computeLeafCount);
  return rootEntries;
}

function computeLeafCount(entry) {
  const children = Array.from(entry.children.values());
  if (children.length === 0) {
    entry.leafCount = 1;
    return entry.leafCount;
  }

  entry.leafCount = children.reduce((total, child) => total + computeLeafCount(child), 0);
  return entry.leafCount;
}

/**
 * Collect the `fullPath` of every non-leaf (branch) node in a topic tree, in
 * pre-order. Optionally restrict to nodes at or below a minimum depth so callers
 * can fold the tree down to a chosen level: collapsing every branch with
 * `depth >= minDepth` hides everything deeper while leaving levels above intact
 * (the fold-tree analogue of the canvas rail's `levelIndex <= selectedLevel`).
 *
 * @param {Array<{node: {fullPath: string, depth: number}, children: Map<string, any>}>} roots
 * @param {object} [options]
 * @param {number} [options.minDepth]
 * @returns {string[]}
 */
export function collectNonLeafPaths(roots, { minDepth = 0 } = {}) {
  const paths = [];
  const traverse = (entry) => {
    const children = Array.from(entry.children.values());
    if (children.length === 0) return;
    if (entry.node.depth >= minDepth) {
      paths.push(entry.node.fullPath);
    }
    children.forEach(traverse);
  };
  (Array.isArray(roots) ? roots : []).forEach(traverse);
  return paths;
}

/**
 * Number of leaf descendants under an entry (1 for a leaf). Used to size a
 * branch row so its children column lines up vertically.
 *
 * @param {{children: Map<string, any>}} entry
 * @returns {number}
 */
export function countLeafDescendants(entry) {
  if (Number.isFinite(entry?.leafCount)) return entry.leafCount;
  const children = Array.from(entry.children.values());
  if (children.length === 0) return 1;
  return children.reduce((total, child) => total + countLeafDescendants(child), 0);
}
