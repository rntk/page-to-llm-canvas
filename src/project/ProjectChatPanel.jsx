import React, { useEffect, useState } from 'react';
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
 * Loads the chat tree when it mounts and again whenever `mergeKey` changes (the
 * project view's merge status/revision). A refresh keeps the current content on
 * screen, so an open conversation is not torn down while the tree reloads.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {{getProjectChatTree?: function(string): Promise<{status: string, tree: object|null, stale: boolean, eligiblePages: object[], skippedPages: object[]}>}} props.api
 * @param {string} [props.mergeKey] Changes whenever the project's topic merge changes.
 * @param {function(): void} [props.onOpenMerge] Opens the merge view (hidden when absent).
 * @param {function(): void} props.onCollapse
 */
export function ProjectChatPanel({ projectId, api, mergeKey = '', onOpenMerge, onCollapse }) {
  const [state, setState] = useState({ projectId: null, loading: true, data: null, error: null });

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        if (typeof api?.getProjectChatTree !== 'function') {
          throw new Error('Project chat is not available');
        }
        return api.getProjectChatTree(projectId);
      })
      .then(
        (data) => active && setState({ projectId, loading: false, data, error: null }),
        (err) =>
          active &&
          setState((prev) => ({
            projectId,
            loading: false,
            // A failed refresh keeps the last good tree for the same project.
            data: prev.projectId === projectId ? prev.data : null,
            error: (err && err.message) || String(err),
          })),
      );
    return () => {
      active = false;
    };
  }, [api, projectId, mergeKey]);

  const current = state.projectId === projectId ? state : null;
  const data = current?.data || null;
  const mergeButton = (label) =>
    onOpenMerge ? (
      <button type="button" onClick={onOpenMerge}>
        {label}
      </button>
    ) : null;

  let body;
  if (!current) {
    body = <p className="note">Loading project chat…</p>;
  } else if (!data) {
    body = (
      <p className="note" role="alert">
        {current.error}
      </p>
    );
  } else if (data.status === 'done' && data.tree) {
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
          stale={data.stale}
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
