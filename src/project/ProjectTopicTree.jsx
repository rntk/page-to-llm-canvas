import React, { useMemo, useState } from 'react';
import TopicsTreeCanvas from '../topics-tree/TopicsTreeCanvas.jsx';
import SourceArticle from '../topics-tree/SourceArticle.jsx';
import { buildSummaryTreeDisplayTree } from '../topics-tree/topicsTreeModel.js';
import { useSourceCardChats } from '../topics-tree/useSourceCardChats.js';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import '../hierarchy/hierarchy.css';
import '../topics-tree/topics-tree.css';

const NO_SENTENCES = [];
const STAGES = {
  passages: 'Reading primary topics',
  topics: 'Merging similar topics',
  summaries: 'Summarizing merged topics',
};

function mergeProgress(tree) {
  const label = STAGES[tree?.stage] || 'Starting';
  const { done = 0, total = 0 } = tree?.progress || {};
  return total ? `${label} ${done}/${total}…` : `${label}…`;
}

/** The project's saved merge, rendered with the same progressive tree as article summaries. */
export function ProjectTopicTree({ project, merge, pending, notice, onBuild, onStop }) {
  const [controlsHost, setControlsHost] = useState(null);
  const tree = merge?.tree;
  const status = merge?.status || SUMMARY_TREE_STATUS.MISSING;
  const running = status === SUMMARY_TREE_STATUS.RUNNING;
  const eligible = Array.isArray(merge?.eligiblePages) ? merge.eligiblePages : [];
  const skipped = Array.isArray(merge?.skippedPages) ? merge.skippedPages : [];
  const treeJson = useMemo(
    () =>
      JSON.stringify(
        !running && tree
          ? {
              rootId: tree.rootId,
              nodes: tree.nodes,
              sources: tree.sources,
            }
          : null,
      ),
    [running, tree],
  );
  const displayTree = useMemo(
    () => buildSummaryTreeDisplayTree(JSON.parse(treeJson), { title: project.title || 'Project' }),
    [treeJson, project.title],
  );
  const leafChat = useSourceCardChats({
    sentences: tree?.sentences || NO_SENTENCES,
    sentenceSources: tree?.sources || null,
    records: tree?.records,
    projectId: project.id,
  });
  const changes = merge?.changes;
  const changeText = changes
    ? [
        changes.added && `${changes.added} new`,
        changes.changed && `${changes.changed} updated`,
        changes.removed && `${changes.removed} removed`,
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  const updatable = status === SUMMARY_TREE_STATUS.DONE && merge?.stale === true;
  const resumable = [
    SUMMARY_TREE_STATUS.CANCELLED,
    SUMMARY_TREE_STATUS.INTERRUPTED,
    SUMMARY_TREE_STATUS.ERROR,
  ].includes(status);
  const stateText = running
    ? mergeProgress(tree)
    : status === SUMMARY_TREE_STATUS.DONE
      ? `Merged topics from ${tree?.records?.length || 0} articles`
      : status === SUMMARY_TREE_STATUS.CANCELLED
        ? 'The merge was stopped.'
        : status === SUMMARY_TREE_STATUS.INTERRUPTED
          ? 'The merge was interrupted.'
          : status === SUMMARY_TREE_STATUS.ERROR
            ? 'The merge failed.'
            : pending
              ? 'Starting the merge…'
              : 'Merge primary topics from completed saved pages in this project.';

  return (
    <section className="th-page project-topic-tree" aria-label="Merged project topics">
      <header className="th-page__bar project-topic-tree__bar">
        <h2 className="th-page__title">Merged project topics</h2>
        <p className="project-topic-tree__state" role="status" title={stateText}>
          {stateText}
        </p>
        <details className="project-topic-tree__sources">
          <summary>
            {eligible.length} eligible {eligible.length === 1 ? 'page' : 'pages'} ·{' '}
            {merge?.topicCount || 0} primary {merge?.topicCount === 1 ? 'topic' : 'topics'}
            {skipped.length > 0 && ` · ${skipped.length} skipped`}
          </summary>
          <div className="project-topic-tree__sources-body">
            {tree?.records?.length > 0 && (
              <>
                <h3>Articles in this merge</h3>
                <ul>
                  {tree.records.map((record) => (
                    <li key={record.key}>
                      <SourceArticle source={record} />
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3>Current eligible pages</h3>
            {eligible.length ? (
              <ul>
                {eligible.map((page) => (
                  <li key={page.key || page.url}>
                    <SourceArticle source={page} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>Save and finish processing pages in this tab group, then merge their topics.</p>
            )}
            {skipped.length > 0 && (
              <>
                <h3>Skipped pages</h3>
                <ul>
                  {skipped.map((page, index) => (
                    <li key={page.url || index}>
                      <SourceArticle source={page} />
                      <span>{page.reason || 'No completed primary topics are available.'}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </details>
        <div className="tt-bar-controls" ref={setControlsHost} />
        <div className="project-topic-tree__actions">
          {running ? (
            onStop && (
              <button type="button" disabled={pending} onClick={onStop}>
                Stop
              </button>
            )
          ) : (
            <>
              {(status !== SUMMARY_TREE_STATUS.DONE || updatable) && (
                <button
                  type="button"
                  disabled={pending || !eligible.length}
                  onClick={() => onBuild({ fresh: false })}
                >
                  {updatable ? 'Add changes' : resumable ? 'Resume' : 'Merge similar topics'}
                </button>
              )}
              {tree && (
                <button
                  type="button"
                  disabled={pending || !eligible.length}
                  onClick={() => onBuild({ fresh: true })}
                >
                  Rebuild
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {(notice || (status === SUMMARY_TREE_STATUS.ERROR && tree?.error) || merge?.stale) && (
        <div className="project-topic-tree__status">
          {notice && <p role="alert">{notice}</p>}
          {status === SUMMARY_TREE_STATUS.ERROR && tree?.error && <p role="alert">{tree.error}</p>}
          {merge?.stale && (
            <p>
              The project&apos;s pages or primary topics have changed
              {changeText && ` (${changeText})`}. Add the changes to the merged topics, or Rebuild
              to regroup everything.
            </p>
          )}
        </div>
      )}
      {displayTree && !running ? (
        <TopicsTreeCanvas
          key={tree.runId || tree.contentRevision}
          tree={displayTree}
          sentences={tree.sentences || []}
          sentenceSources={tree.sources || {}}
          leafChat={leafChat}
          controlsHost={controlsHost}
        />
      ) : (
        <div className="th-page__state">
          {running || pending
            ? 'The merge runs in the background. You can switch to the Canvas tab and come back later.'
            : eligible.length
              ? 'Similar primary topics will share a branch. Unfold a branch to read each article’s original text with its source and line numbers.'
              : 'No completed saved pages with primary topics are available in this project.'}
        </div>
      )}
    </section>
  );
}
