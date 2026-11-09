import React, { useState } from 'react';
import { ProjectChat } from './ProjectChat.jsx';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import { describeMerge } from './projectMergeState.js';
import { PROJECT_CHAT_PANEL_ID } from './projectText.js';

const STALE_NOTICE =
  'Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages.';

const INCOMPLETE_TEXT = {
  [SUMMARY_TREE_STATUS.RUNNING]:
    'Similar topics are still being merged. Chat is available once the merge finishes.',
  [SUMMARY_TREE_STATUS.INTERRUPTED]:
    'The topic merge stopped before it finished. Resume it to chat over this project.',
  [SUMMARY_TREE_STATUS.CANCELLED]:
    'The topic merge was stopped. Resume it to chat over this project.',
  [SUMMARY_TREE_STATUS.ERROR]:
    'The topic merge failed. Open it to retry and chat over this project.',
};

const MISSING_TEXT =
  'Project chat answers from the project’s merged topics and their source sentences. Merge similar topics first to start chatting.';

/**
 * Collapsible project chat over the project's merged topic tree.
 *
 * Renders straight from the project view's `topicMerge` (the single owner of
 * the merge snapshot), so the chat can never lag behind what the merge view shows.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {{status?: string, tree?: object|null, stale?: boolean, eligiblePages?: object[], skippedPages?: object[]}|null} [props.merge]
 *   The project view's topic merge.
 * @param {function(): void} [props.onOpenMerge] Opens the merge view (hidden when absent).
 * @param {function(): void} props.onCollapse
 */
export function ProjectChatPanel({ projectId, merge, onOpenMerge, onCollapse }) {
  // The chat's History/New actions share the panel header row.
  const [actionsTarget, setActionsTarget] = useState(null);
  const { status, ready, skipped } = describeMerge(merge);
  const mergeButton = (label) =>
    onOpenMerge ? (
      <button type="button" onClick={onOpenMerge}>
        {label}
      </button>
    ) : null;

  let body;
  if (ready) {
    body = (
      <>
        {merge.stale && (
          <div className="chat-panel-notice" role="status">
            <p className="note">{STALE_NOTICE}</p>
            {mergeButton('Rebuild merge')}
          </div>
        )}
        {skipped.length > 0 && (
          <p className="note chat-panel-skipped" role="status">
            {skipped.length === 1
              ? '1 page is not included (not saved or still processing).'
              : `${skipped.length} pages are not included (not saved or still processing).`}
          </p>
        )}
        <ProjectChat
          projectId={projectId}
          tree={merge.tree}
          eligiblePages={merge.eligiblePages}
          skippedPages={merge.skippedPages}
          stale={merge.stale === true}
          headerActionsTarget={actionsTarget}
        />
      </>
    );
  } else {
    const incomplete = INCOMPLETE_TEXT[status];
    body = (
      <div className="chat-panel-empty">
        <p className="note">{incomplete || MISSING_TEXT}</p>
        {mergeButton(incomplete ? 'Open topic merge' : 'Merge similar topics')}
      </div>
    );
  }

  return (
    <aside id={PROJECT_CHAT_PANEL_ID} className="chat-panel" aria-label="Project chat">
      <header className="chat-panel-header">
        <h2>Project chat</h2>
        <span className="chat-panel-actions" ref={setActionsTarget} />
        <button type="button" onClick={onCollapse} aria-label="Collapse project chat">
          Hide
        </button>
      </header>
      <div className="chat-panel-body">{body}</div>
    </aside>
  );
}
