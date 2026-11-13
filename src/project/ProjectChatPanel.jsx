import React, { useMemo, useState } from 'react';
import { ProjectChat } from './ProjectChat.jsx';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import { shareEqual } from '../shared/runtime/shareEqual.js';
import { describeMerge } from './projectMergeState.js';
import { buildProjectChatPages } from './projectChatPages.js';
import { PROJECT_CHAT_PANEL_ID } from './projectText.js';

const STALE_NOTICE =
  'Pages or topics changed since this merge. Answers use the saved merge — rebuild to include current pages.';

const NO_PAGES_TEXT = 'This project has no pages to chat about yet.';
const NO_READABLE_PAGES_TEXT = 'None of this project’s pages can be read by the chat.';

// Shown when there is no merged topic tree: the chat works without one.
const MERGE_HINT_TEXT = {
  [SUMMARY_TREE_STATUS.RUNNING]:
    'Similar topics are still being merged. The chat can use the shared topic tree once the merge finishes.',
  [SUMMARY_TREE_STATUS.INTERRUPTED]:
    'The topic merge stopped before it finished. Resume it to add a shared topic tree the chat can use.',
  [SUMMARY_TREE_STATUS.CANCELLED]:
    'The topic merge was stopped. Resume it to add a shared topic tree the chat can use.',
  [SUMMARY_TREE_STATUS.ERROR]:
    'The topic merge failed. Open it to retry and add a shared topic tree the chat can use.',
};

const MISSING_HINT_TEXT = 'Merging similar topics adds a shared topic tree the chat can use.';

const skippedNote = (count) =>
  count === 1
    ? '1 page is not in the topic tree (not saved or still processing).'
    : `${count} pages are not in the topic tree (not saved or still processing).`;

/**
 * Collapsible project chat over the project's pages, with the merged topic tree
 * as an optional extra source.
 *
 * The chat works whenever the project has a readable page. The merge comes from
 * the project view's `topicMerge` (the single owner of the merge snapshot); its
 * tree is handed to the chat only once the merge is complete.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {Array<{title?: string, url?: string}>} [props.tabs] The project view's open tabs.
 * @param {{status?: string, tree?: object|null, stale?: boolean, eligiblePages?: object[], skippedPages?: object[]}|null} [props.merge]
 *   The project view's topic merge.
 * @param {function(string): Promise<object>} props.readPage Reads a page's text by URL.
 * @param {function(object): Promise<object>} props.send Raw runtime request for chat turns.
 * @param {function(): void} [props.onOpenMerge] Opens the merge view (hidden when absent).
 * @param {function(object, {focus?: boolean}=): void} [props.onHighlight] Painted page highlights (see ProjectChat).
 * @param {function(): void} [props.onClearHighlights]
 * @param {function(): void} props.onCollapse
 */
export function ProjectChatPanel({
  projectId,
  tabs,
  merge,
  readPage,
  send,
  onOpenMerge,
  onHighlight,
  onClearHighlights,
  onCollapse,
}) {
  // The chat's History/New actions share the panel header row.
  const [actionsTarget, setActionsTarget] = useState(null);
  const { status, ready, skipped } = describeMerge(merge);
  const eligiblePages = merge?.eligiblePages;
  const savedRecords = merge?.tree?.records;
  const computed = useMemo(
    () =>
      buildProjectChatPages({
        tabs,
        savedPages: [...(eligiblePages || []), ...(savedRecords || [])],
      }),
    [tabs, eligiblePages, savedRecords],
  );
  // Tabs are refetched as new objects on every view refresh; keeping the page
  // lists identical while their content is, keeps the chat's runner stable.
  const [stable, setStable] = useState(computed);
  const shared = shareEqual(stable, computed);
  if (shared !== stable) setStable(shared);
  const { pages, unreadablePages } = shared;

  const mergeButton = (label) =>
    onOpenMerge ? (
      <button type="button" onClick={onOpenMerge}>
        {label}
      </button>
    ) : null;

  let body;
  if (!pages.length) {
    body = (
      <div className="chat-panel-empty">
        <p className="note">{unreadablePages.length ? NO_READABLE_PAGES_TEXT : NO_PAGES_TEXT}</p>
      </div>
    );
  } else {
    const hint = MERGE_HINT_TEXT[status];
    body = (
      <>
        {ready && merge.stale && (
          <div className="chat-panel-notice" role="status">
            <p className="note">{STALE_NOTICE}</p>
            {mergeButton('Rebuild merge')}
          </div>
        )}
        {ready && skipped.length > 0 && (
          <p className="note chat-panel-skipped" role="status">
            {skippedNote(skipped.length)}
          </p>
        )}
        {!ready && (
          <div className="chat-panel-notice">
            <p className="note">{hint || MISSING_HINT_TEXT}</p>
            {mergeButton(hint ? 'Open topic merge' : 'Merge similar topics')}
          </div>
        )}
        <ProjectChat
          projectId={projectId}
          pages={pages}
          unreadablePages={unreadablePages}
          readPage={readPage}
          send={send}
          tree={ready ? merge.tree : null}
          eligiblePages={ready ? merge.eligiblePages : undefined}
          skippedPages={ready ? merge.skippedPages : undefined}
          stale={ready && merge.stale === true}
          headerActionsTarget={actionsTarget}
          onHighlight={onHighlight}
          onClearHighlights={onClearHighlights}
        />
      </>
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
