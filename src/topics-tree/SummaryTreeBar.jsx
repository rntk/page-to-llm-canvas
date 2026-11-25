import { SUMMARY_TREE_STAGE, SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';

const DEFAULT_STAGE_LABELS = {
  [SUMMARY_TREE_STAGE.PASSAGES]: 'Summarizing passages',
  [SUMMARY_TREE_STAGE.TOPICS]: 'Grouping topics',
  [SUMMARY_TREE_STAGE.SUMMARIES]: 'Summarizing topics',
};

const BUILD_NOTICES = {
  [SUMMARY_TREE_STATUS.INTERRUPTED]: 'The build was interrupted.',
  [SUMMARY_TREE_STATUS.CANCELLED]: 'The build was stopped.',
};

function progressText(tree, stageLabels) {
  const label = stageLabels[tree?.stage] || 'Starting';
  const { done = 0, total = 0 } = tree?.progress || {};
  return total > 0 ? `${label} ${done}/${total}…` : `${label}…`;
}

function defaultDescribeDone(tree) {
  const metrics = tree?.metrics || {};
  return `${metrics.passages ?? 0} passages · ${metrics.topics ?? 0} topics`;
}

/**
 * Status and actions of a derived tree build, shown in the page bar.
 * @param {object} props
 * @param {string} props.status Effective build status.
 * @param {object|null} props.tree Saved tree.
 * @param {string} props.notice Last action error.
 * @param {function({fresh: boolean}): void} [props.onBuild]
 * @param {function(): void} [props.onStop]
 * @param {Record<string, string>} [props.stageLabels]
 * @param {function(object|null): string} [props.describeDone]
 * @param {string} [props.introText]
 * @param {string} [props.buildLabel]
 * @param {string} [props.rebuildTitle]
 * @param {string} [props.resumeTitle]
 */
export default function SummaryTreeBar({
  status,
  tree,
  notice,
  onBuild,
  onStop,
  stageLabels = DEFAULT_STAGE_LABELS,
  describeDone = defaultDescribeDone,
  introText = 'Not built yet. The summary tree groups brief passage summaries into topics and summarizes each level from the one below, citing its sources.',
  buildLabel = 'Build summary tree',
  rebuildTitle = 'Build the summary tree again from scratch',
  resumeTitle = 'Continue from the completed summaries',
}) {
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
      text = progressText(tree, stageLabels);
      action('Stop', onStop);
      break;
    case SUMMARY_TREE_STATUS.DONE: {
      text = describeDone(tree);
      action('Rebuild', rebuild, rebuildTitle);
      break;
    }
    case SUMMARY_TREE_STATUS.ERROR:
    case SUMMARY_TREE_STATUS.CANCELLED:
    case SUMMARY_TREE_STATUS.INTERRUPTED:
      text = BUILD_NOTICES[status] || `The build failed: ${tree?.error || 'unknown error'}`;
      action('Resume', build, resumeTitle);
      action('Rebuild', rebuild, rebuildTitle);
      break;
    default:
      text = introText;
      action(buildLabel, build);
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
