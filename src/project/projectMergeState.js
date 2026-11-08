import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';

const STAGES = {
  passages: 'Reading primary topics',
  topics: 'Merging similar topics',
  summaries: 'Summarizing merged topics',
};

// Statuses whose unfinished build can be continued with `build({ fresh: false })`.
const RESUMABLE = new Set([
  SUMMARY_TREE_STATUS.CANCELLED,
  SUMMARY_TREE_STATUS.INTERRUPTED,
  SUMMARY_TREE_STATUS.ERROR,
]);

const STATE_TEXT = {
  [SUMMARY_TREE_STATUS.CANCELLED]: 'The merge was stopped.',
  [SUMMARY_TREE_STATUS.INTERRUPTED]: 'The merge was interrupted.',
  [SUMMARY_TREE_STATUS.ERROR]: 'The merge failed.',
};

function progressText(tree) {
  const label = STAGES[tree?.stage] || 'Starting';
  const { done = 0, total = 0 } = tree?.progress || {};
  return total ? `${label} ${done}/${total}…` : `${label}…`;
}

function changesText(changes) {
  if (!changes) return '';
  return [
    changes.added && `${changes.added} new`,
    changes.changed && `${changes.changed} updated`,
    changes.removed && `${changes.removed} removed`,
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * What a project's topic merge means for the views: the single place that
 * interprets the merge status.
 *
 * @param {{status?: string, tree?: object|null, stale?: boolean, eligiblePages?: object[],
 *   skippedPages?: object[], changes?: {added: number, changed: number, removed: number}|null}|null|undefined} merge
 *   The project view's `topicMerge`.
 * @param {{pending?: boolean}} [options] `pending`: a merge command is in flight.
 * @returns {{status: string, running: boolean, ready: boolean, resumable: boolean,
 *   updatable: boolean, needsBuild: boolean, eligible: object[], skipped: object[],
 *   changeText: string, stateText: string}}
 */
export function describeMerge(merge, { pending = false } = {}) {
  const status = merge?.status || SUMMARY_TREE_STATUS.MISSING;
  const tree = merge?.tree || null;
  const stale = merge?.stale === true;
  const eligible = Array.isArray(merge?.eligiblePages) ? merge.eligiblePages : [];
  const skipped = Array.isArray(merge?.skippedPages) ? merge.skippedPages : [];
  const running = status === SUMMARY_TREE_STATUS.RUNNING;
  const done = status === SUMMARY_TREE_STATUS.DONE;
  const resumable = RESUMABLE.has(status);

  let stateText;
  if (running) stateText = progressText(tree);
  else if (done) stateText = `Merged topics from ${tree?.records?.length || 0} articles`;
  else
    stateText =
      STATE_TEXT[status] ||
      (pending
        ? 'Starting the merge…'
        : 'Merge primary topics from completed saved pages in this project.');

  return {
    status,
    running,
    // A finished tree the chat can answer from.
    ready: done && !!tree,
    resumable,
    updatable: done && stale,
    // Opening the merge view should start (or continue) a build. Unknown pages
    // (view not loaded) count as none, matching the disabled build buttons.
    needsBuild: !running && eligible.length > 0 && (!tree || stale || resumable),
    eligible,
    skipped,
    changeText: changesText(merge?.changes),
    stateText,
  };
}
