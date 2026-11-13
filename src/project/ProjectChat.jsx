import React, { useMemo, useState } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createProjectChatContext } from '../core/projects/projectChatTools.js';
import { projectChatKey } from '../core/storage/keys.js';
import { MSG } from '../shared/runtime/messages.js';
import { createProjectChatTurnRunner } from './projectChatTurn.js';

const PROJECT_PROMPT =
  'Ask about this project’s pages. The assistant first checks each page for relevance to your question, then reads the pages it needs and highlights the passages it relies on as evidence cards on the canvas.';

// ArticleChat only needs to know this is a project chat; the turn runner
// supplies the overview (`preamble`) for each turn.
const PROJECT_SOURCE = Object.freeze({ kind: 'project', preamble: '' });

const NO_PAGES = [];

/**
 * The project's own chat, filling the side chat panel. Turns send no article
 * text: the model gets an overview of the project's pages (with a per-page
 * relevance scan on a chat's first question) and reads pages through tools,
 * highlighting the page lines it relies on as chat events. The painted events
 * go to `onHighlight`/`onClearHighlights` (the canvas shows them as evidence
 * cards under their pages). A merged topic tree, when given, adds its own tools.
 *
 * @param {object} props
 * @param {string} props.projectId
 * @param {Array<{page: number, title: string, url: string}>} props.pages Readable pages, numbered from 1.
 * @param {Array<{title?: string, url?: string, reason?: string}>} [props.unreadablePages]
 * @param {function(string): Promise<object>} props.readPage Reads a page's text by URL.
 * @param {function(object): Promise<object>} props.send Raw runtime request (scan config,
 *   completion, scan decision, cancellation).
 * @param {?object} [props.tree] The project's merged topic tree, when a usable one exists.
 * @param {object[]} [props.eligiblePages] Pages in the merged tree.
 * @param {object[]} [props.skippedPages] Pages left out of the merged tree.
 * @param {boolean} [props.stale] Whether pages or topics changed since the merge.
 * @param {function(object, {focus?: boolean}=): void} [props.onHighlight] Receives each
 *   painted page highlight (see ArticleChat); keep it stable.
 * @param {function(): void} [props.onClearHighlights] Runs before every repaint.
 * @param {?HTMLElement} [props.headerActionsTarget] Where the chat's History/New
 *   actions render (the panel header); see ArticleChat.
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise. A
 *   `runTurn` here is the function the project turn runner wraps.
 */
export function ProjectChat({
  projectId,
  pages,
  unreadablePages = NO_PAGES,
  readPage,
  send,
  tree = null,
  eligiblePages,
  skippedPages,
  stale,
  headerActionsTarget,
  onHighlight,
  onClearHighlights,
  chatPorts,
}) {
  const [scanProgress, setScanProgress] = useState(null);
  const { runTurn: wrappedRunTurn, ...articleChatPorts } = chatPorts || {};
  // useProjectView keeps an unchanged merge's objects identical across reloads,
  // so the (costly) tree tools and ArticleChat's props only change with content.
  const treeContext = useMemo(() => (tree ? createProjectChatContext(tree) : null), [tree]);
  const treeOverviewInput = useMemo(
    () => ({ eligiblePages, skippedPages, stale: stale === true }),
    [eligiblePages, skippedPages, stale],
  );
  const runTurn = useMemo(
    () =>
      createProjectChatTurnRunner({
        pages,
        unreadablePages,
        readPage,
        getScanConfig: () => send({ type: MSG.getProjectChatScanConfig }),
        send,
        treeContext,
        treeOverviewInput,
        runTurn: wrappedRunTurn,
        onScanProgress: setScanProgress,
      }),
    [pages, unreadablePages, readPage, send, treeContext, treeOverviewInput, wrappedRunTurn],
  );

  return (
    <div className="page-chat-body project-chat">
      {scanProgress && (
        <p className="note chat-panel-skipped" role="status">
          {`Checking pages for relevance… ${scanProgress.done}/${scanProgress.total}`}
        </p>
      )}
      <ArticleChat
        recordKey={projectChatKey(projectId)}
        source={PROJECT_SOURCE}
        emptyPrompt={PROJECT_PROMPT}
        headerActionsTarget={headerActionsTarget}
        runTurn={runTurn}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
        {...articleChatPorts}
      />
    </div>
  );
}
