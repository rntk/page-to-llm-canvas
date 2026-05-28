/**
 * Build a nested tree from a flat list of topics whose `name` encodes a
 * hierarchy path ("A > B > C"). Returns an array of root tree entries.
 *
 * Each entry: { node, children: Map<string, entry>, parent }
 * node: { name, fullPath, uid, depth, topic }
 * `fullPath` joins parts with ">" (no spaces) so it matches the convention
 * used by isAncestorPath / the color helpers.
 *
 * @param {Array<{name: string, sentences?: number[]}>} topics
 * @param {number} [startDepth]
 */
export function buildTopicTree(topics, startDepth = 0) {
  const roots = new Map();

  for (const topic of Array.isArray(topics) ? topics : []) {
    const parts = String(topic?.name || "")
      .split(">")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length <= startDepth) continue;

    let level = roots;
    let parent = null;
    for (let i = startDepth; i < parts.length; i += 1) {
      const name = parts[i];
      const fullPath = parts.slice(0, i + 1).join(">");
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

  return Array.from(roots.values());
}

/**
 * Number of leaf descendants under an entry (1 for a leaf). Used to size a
 * branch row so its children column lines up vertically.
 *
 * @param {{children: Map<string, any>}} entry
 * @returns {number}
 */
export function countLeafDescendants(entry) {
  const children = Array.from(entry.children.values());
  if (children.length === 0) return 1;
  return children.reduce((total, child) => total + countLeafDescendants(child), 0);
}
