import React, { useCallback, useEffect, useState } from 'react';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { ProjectChatPanel } from './ProjectChatPanel.jsx';
import { ProjectHeader } from './ProjectHeader.jsx';
import { PageChatDrawer } from './PageChatDrawer.jsx';
import { ExcerptChatDrawer } from './ExcerptChatDrawer.jsx';
import { UNTITLED_PROJECT } from './projectText.js';
import { useProjectView } from './useProjectView.js';
import { browserScheduler } from '../shared/runtime/browserHosts.js';

const NO_EXCERPTS = [];

function ErrorState({ title, message, pageHost }) {
  return (
    <main className="project-state" role="alert">
      <h1>{title}</h1>
      <p className="note">{message}</p>
      {pageHost && (
        <button type="button" onClick={() => pageHost.openOptions()}>
          Open options
        </button>
      )}
    </main>
  );
}

/**
 * Project canvas page: one tab group rendered as a pannable canvas of tab cards.
 *
 * @param {object} props
 * @param {string|null} props.projectId
 * @param {{getProjectView: function(string): Promise<{project: object, isOpen: boolean, tabs: object[]}>, getPageChat?: Function, capturePageText?: Function, readExcerptPage?: Function, deleteExcerpt?: Function}} props.api
 *   `getPageChat`/`capturePageText` back the per-page chat drawers;
 *   `readExcerptPage`/`deleteExcerpt` back excerpt cards and their chats.
 * @param {function(function(): void): function(): void} [props.subscribe]
 *   Change subscription (see `subscribeProjectChanges`).
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 * @param {{openOptions: function(): void}} props.pageHost
 * @param {{setTimeout: function, clearTimeout: function}} [props.scheduler]
 */
export function ProjectApp({
  projectId,
  api,
  subscribe,
  tabsHost,
  pageHost,
  scheduler = browserScheduler,
}) {
  const { status, view, error } = useProjectView({ projectId, api, subscribe, scheduler });
  const [chatOpen, setChatOpen] = useState(true);
  const renderPageChat = useCallback(
    (tab, { onClose }) => (
      <PageChatDrawer projectId={projectId} tab={tab} api={api} onClose={onClose} />
    ),
    [api, projectId],
  );
  const renderExcerptChat = useCallback(
    (excerpt, { onClose }) => (
      <ExcerptChatDrawer projectId={projectId} excerpt={excerpt} api={api} onClose={onClose} />
    ),
    [api, projectId],
  );
  const deleteExcerpt = useCallback(
    (excerpt) => api.deleteExcerpt(projectId, excerpt.id),
    [api, projectId],
  );

  const title = view ? view.project.title || UNTITLED_PROJECT : null;
  useEffect(() => {
    if (title) document.title = `${title} · Project`;
  }, [title]);

  if (status === 'idle') {
    return (
      <ErrorState
        title="No project selected"
        message="This page needs a project id. Open a project from the extension options page."
        pageHost={pageHost}
      />
    );
  }
  if (status === 'loading') return <p className="note project-loading">Loading…</p>;
  if (status === 'error') {
    return (
      <ErrorState
        title="Project unavailable"
        message={`${error} — it may have been deleted. You can manage projects from the options page.`}
        pageHost={pageHost}
      />
    );
  }

  const tabs = view.tabs;
  return (
    <div className="project-shell">
      <ProjectHeader
        project={view.project}
        isOpen={view.isOpen}
        tabCount={tabs.length}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
      />
      <div className="project-body">
        <div className="project-canvas-wrap">
          <ProjectCanvas
            tabs={tabs}
            excerpts={view.excerpts || NO_EXCERPTS}
            focusExcerptId={view.focusExcerptId || null}
            tabsHost={tabsHost}
            renderPageChat={renderPageChat}
            renderExcerptChat={api.readExcerptPage ? renderExcerptChat : undefined}
            onDeleteExcerpt={api.deleteExcerpt ? deleteExcerpt : undefined}
          />
          {!view.isOpen && (
            <p className="canvas-hint" role="status">
              This project&apos;s tab group is closed
            </p>
          )}
          {view.isOpen && tabs.length === 0 && (
            <p className="canvas-hint" role="status">
              Add tabs to this tab group to see them here
            </p>
          )}
        </div>
        {chatOpen && <ProjectChatPanel onCollapse={() => setChatOpen(false)} />}
      </div>
    </div>
  );
}
