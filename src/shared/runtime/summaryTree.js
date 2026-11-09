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
// A running tree older than this without a save was interrupted.
export const SUMMARY_TREE_STALE_MS = 3 * SUMMARY_TREE_HEARTBEAT_MS;

/**
 * The record's summary tree with its effective status. A tree saved for other
 * content, or a running tree that stopped saving, is reported as such.
 * @param {object|null|undefined} record
 * @param {number} [now]
 * @returns {{status: string, tree: object|null}}
 */
export function readSummaryTree(record, now = Date.now()) {
  const tree = record?.summary_tree;
  if (
    !tree ||
    typeof tree !== 'object' ||
    tree.version !== SUMMARY_TREE_VERSION ||
    tree.contentRevision !== record.contentRevision
  ) {
    return { status: SUMMARY_TREE_STATUS.MISSING, tree: null };
  }
  const stale =
    tree.status === SUMMARY_TREE_STATUS.RUNNING &&
    !(Number.isFinite(tree.updatedAt) && now - tree.updatedAt <= SUMMARY_TREE_STALE_MS);
  return { status: stale ? SUMMARY_TREE_STATUS.INTERRUPTED : tree.status, tree };
}

/**
 * Only builds explicitly started under background recovery may auto-resume.
 * Legacy RUNNING trees retain the manual Resume behavior, even if recent.
 * Opted-in builds may outlive the heartbeat window (e.g. a browser restart).
 * @param {object|null|undefined} record
 */
export function canRecoverSummaryTree(record) {
  return (
    record?.summary_tree?.backgroundRecovery === true &&
    readSummaryTree(record, record.summary_tree.updatedAt).status === SUMMARY_TREE_STATUS.RUNNING
  );
}
