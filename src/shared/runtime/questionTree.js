// Persisted `question_tree` contract shared by the worker stage and the topic views.

import { SUMMARY_TREE_STALE_MS, SUMMARY_TREE_STATUS } from './summaryTree.js';

export const QUESTION_TREE_VERSION = 1;

export const QUESTION_TREE_STATUS = SUMMARY_TREE_STATUS;

export const QUESTION_TREE_STAGE = Object.freeze({
  QUESTIONS: 'questions',
  GROUPING: 'grouping',
  DONE: 'done',
});

/**
 * Tree with its effective status: MISSING when absent or saved for other content,
 * INTERRUPTED for a running tree that stopped saving.
 * @param {object|null|undefined} tree
 * @param {*} expectedContentRevision
 * @param {number} [now]
 * @returns {{status: string, tree: object|null}}
 */
export function readQuestionTree(tree, expectedContentRevision, now = Date.now()) {
  if (
    !tree ||
    typeof tree !== 'object' ||
    tree.version !== QUESTION_TREE_VERSION ||
    tree.contentRevision !== expectedContentRevision
  ) {
    return { status: QUESTION_TREE_STATUS.MISSING, tree: null };
  }
  const stale =
    tree.status === QUESTION_TREE_STATUS.RUNNING &&
    !(Number.isFinite(tree.updatedAt) && now - tree.updatedAt <= SUMMARY_TREE_STALE_MS);
  return { status: stale ? QUESTION_TREE_STATUS.INTERRUPTED : tree.status, tree };
}

/**
 * Only builds started with background recovery auto-resume, even past the heartbeat
 * window (e.g. after a browser restart).
 * @param {object|null|undefined} tree
 * @param {*} expectedContentRevision
 * @returns {boolean}
 */
export function canRecoverQuestionTree(tree, expectedContentRevision) {
  return (
    tree?.backgroundRecovery === true &&
    readQuestionTree(tree, expectedContentRevision, tree.updatedAt).status ===
      QUESTION_TREE_STATUS.RUNNING
  );
}
