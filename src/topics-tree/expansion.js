import { textKey } from './displayTree.js';

// Expansion state over a display tree: which nodes are open, and the tree
// views derived from it. Pure functions only, so they run without a DOM.

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
  if (tree.textCard?.key === key) return [tree, tree.textCard];
  for (const child of tree.children) {
    const path = pathTo(child, key);
    if (path.length) return [tree, ...path];
  }
  return [];
}

function collapseSubtree(node, expanded) {
  if (!node) return;
  expanded.delete(node.key);
  expanded.delete(textKey(node.key));
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
  if (next.has(textKey(key))) {
    // Folding a node that shows its source text closes that text.
    next.delete(textKey(key));
    return next;
  }
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
    next.delete(textKey(node.key));
    node.children.forEach(walk);
  };
  const start = pathTo(tree, key).at(-1);
  if (start) walk(start);
  return next;
}

/**
 * Show a node's whole source text in place of its child branches (or close it
 * again). The node's ancestors open so the block is visible.
 * @param {object|null} tree Display tree.
 * @param {Set<string>} expanded Keys of the open nodes.
 * @param {string} key Display node key.
 * @returns {Set<string>}
 */
export function toggleText(tree, expanded, key) {
  const node = pathTo(tree, key).at(-1);
  if (!node?.textCard) return new Set(expanded);
  if (expanded.has(textKey(key))) {
    const next = new Set(expanded);
    next.delete(textKey(key));
    return next;
  }
  const next = revealNode(tree, expanded, key);
  collapseSubtree(node, next);
  next.add(textKey(key));
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
  if (tree.textCard && expanded.has(textKey(tree.key))) {
    return { ...tree, hiddenCount: 0, children: [tree.textCard] };
  }
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
