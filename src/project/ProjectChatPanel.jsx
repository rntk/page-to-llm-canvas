import React from 'react';
import { ProjectChat } from './ProjectChat.jsx';

const STALE_NOTICE =
  'Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages.';

const INCOMPLETE_TEXT = {
  running: 'Similar topics are still being merged. Chat is available once the merge finishes.',
  interrupted: 'The topic merge stopped before it finished. Resume it to chat over this project.',
  cancelled: 'The topic merge was stopped. Resume it to chat over this project.',
  error: 'The topic merge failed. Open it to retry and chat over this project.',
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
  const data = merge || { status: undefined, tree: null };
  const mergeButton = (label) =>
    onOpenMerge ? (
      <button type="button" onClick={onOpenMerge}>
        {label}
      </button>
    ) : null;

  let body;
  if (data.status === 'done' && data.tree) {
    const skipped = data.skippedPages?.length || 0;
    body = (
      <>
        {data.stale && (
          <div className="chat-panel-notice" role="status">
            <p className="note">{STALE_NOTICE}</p>
            {mergeButton('Rebuild merge')}
          </div>
        )}
        {skipped > 0 && (
          <p className="note chat-panel-skipped" role="status">
            {skipped === 1
              ? '1 page is not included (not saved or still processing).'
              : `${skipped} pages are not included (not saved or still processing).`}
          </p>
        )}
        <ProjectChat
          projectId={projectId}
          tree={data.tree}
          eligiblePages={data.eligiblePages}
          skippedPages={data.skippedPages}
          stale={data.stale === true}
        />
      </>
    );
  } else {
    const text = INCOMPLETE_TEXT[data.status] || MISSING_TEXT;
    body = (
      <div className="chat-panel-empty">
        <p className="note">{text}</p>
        {mergeButton(INCOMPLETE_TEXT[data.status] ? 'Open topic merge' : 'Merge similar topics')}
      </div>
    );
  }

  return (
    <aside className="chat-panel" aria-label="Project chat">
      <header className="chat-panel-header">
        <h2>Project chat</h2>
        <button type="button" onClick={onCollapse} aria-label="Collapse project chat">
          Hide
        </button>
      </header>
      <div className="chat-panel-body">{body}</div>
    </aside>
  );
}
