import { SUMMARY_TREE_STAGE, SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';

const STAGE_LABELS = {
  [SUMMARY_TREE_STAGE.PASSAGES]: 'Summarizing passages',
  [SUMMARY_TREE_STAGE.TOPICS]: 'Grouping topics',
  [SUMMARY_TREE_STAGE.SUMMARIES]: 'Summarizing topics',
};

const BUILD_NOTICES = {
  [SUMMARY_TREE_STATUS.INTERRUPTED]: 'The build was interrupted.',
  [SUMMARY_TREE_STATUS.CANCELLED]: 'The build was stopped.',
};

function progressText(tree) {
  const label = STAGE_LABELS[tree?.stage] || 'Starting';
  const { done = 0, total = 0 } = tree?.progress || {};
  return total > 0 ? `${label} ${done}/${total}…` : `${label}…`;
}

/**
 * Status and actions of the summary tree build, shown in the page bar.
 * @param {object} props
 * @param {string} props.status Effective summary tree status.
 * @param {object|null} props.tree Saved summary tree.
 * @param {string} props.notice Last action error.
 * @param {function({fresh: boolean}): void} [props.onBuild]
 * @param {function(): void} [props.onStop]
 */
export default function SummaryTreeBar({ status, tree, notice, onBuild, onStop }) {
  let text;
  const actions = [];
  const action = (label, onClick, title) =>
    onClick &&
    actions.push(
      <button key={label} type="button" className="tt-btn" title={title} onClick={onClick}>
        {label}
      </button>,
    );
  const build = onBuild && (() => onBuild({ fresh: false }));
  const rebuild = onBuild && (() => onBuild({ fresh: true }));
  switch (status) {
    case SUMMARY_TREE_STATUS.RUNNING:
      text = progressText(tree);
      action('Stop', onStop);
      break;
    case SUMMARY_TREE_STATUS.DONE: {
      const metrics = tree?.metrics || {};
      text = `${metrics.passages ?? 0} passages · ${metrics.topics ?? 0} topics`;
      action('Rebuild', rebuild, 'Build the summary tree again from scratch');
      break;
    }
    case SUMMARY_TREE_STATUS.ERROR:
    case SUMMARY_TREE_STATUS.CANCELLED:
    case SUMMARY_TREE_STATUS.INTERRUPTED:
      text = BUILD_NOTICES[status] || `The build failed: ${tree?.error || 'unknown error'}`;
      action('Resume', build, 'Continue from the completed summaries');
      action('Rebuild', rebuild, 'Build the summary tree again from scratch');
      break;
    default:
      text =
        'Not built yet. The summary tree groups brief passage summaries into topics and summarizes each level from the one below, citing its sources.';
      action('Build summary tree', build);
  }
  return (
    <div className="tt-source-status" role="status">
      <span className="tt-muted tt-source-status__text" title={text}>
        {text}
      </span>
      {notice && (
        <span className="tt-source-status__notice" title={notice}>
          {notice}
        </span>
      )}
      {actions}
    </div>
  );
}
