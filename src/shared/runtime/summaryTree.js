// Persisted `summary_tree` contract shared by the worker stage and the views.

export const SUMMARY_TREE_VERSION = 1;

export const SUMMARY_TREE_STATUS = Object.freeze({
  RUNNING: 'running',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  // View-only: a running tree whose build stopped saving (worker restarted).
  INTERRUPTED: 'interrupted',
  MISSING: 'missing',
});

export const SUMMARY_TREE_STAGE = Object.freeze({
  PASSAGES: 'passages',
  TOPICS: 'topics',
  SUMMARIES: 'summaries',
  DONE: 'done',
});

// A running build saves at least this often, even while requests are in flight.
export const SUMMARY_TREE_HEARTBEAT_MS = 20_000;
// A running tree with no save inside this window is treated as interrupted.
export const SUMMARY_TREE_STALE_MS = 3 * SUMMARY_TREE_HEARTBEAT_MS;

/**
 * Tree with its effective status: MISSING when absent or saved for other content,
 * INTERRUPTED for a running tree that stopped saving.
 * @param {object|null|undefined} tree
 * @param {*} expectedContentRevision
 * @param {number} [now]
 * @returns {{status: string, tree: object|null}}
 */
export function readSummaryTree(tree, expectedContentRevision, now = Date.now()) {
  if (
    !tree ||
    typeof tree !== 'object' ||
    tree.version !== SUMMARY_TREE_VERSION ||
    tree.contentRevision !== expectedContentRevision
  ) {
    return { status: SUMMARY_TREE_STATUS.MISSING, tree: null };
  }
  const stale =
    tree.status === SUMMARY_TREE_STATUS.RUNNING &&
    !(Number.isFinite(tree.updatedAt) && now - tree.updatedAt <= SUMMARY_TREE_STALE_MS);
  return { status: stale ? SUMMARY_TREE_STATUS.INTERRUPTED : tree.status, tree };
}

/**
 * Only builds started with background recovery auto-resume, even past the heartbeat
 * window (e.g. after a browser restart). Legacy RUNNING trees keep manual Resume.
 * @param {object|null|undefined} tree
 * @param {*} expectedContentRevision
 */
export function canRecoverSummaryTree(tree, expectedContentRevision) {
  return (
    tree?.backgroundRecovery === true &&
    readSummaryTree(tree, expectedContentRevision, tree.updatedAt).status ===
      SUMMARY_TREE_STATUS.RUNNING
  );
}
