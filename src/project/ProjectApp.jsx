import React, { useCallback, useEffect, useState } from 'react';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { ProjectChatPanel } from './ProjectChatPanel.jsx';
import { ProjectHeader } from './ProjectHeader.jsx';
import { PageChatDrawer } from './PageChatDrawer.jsx';
import { ExcerptChatDrawer } from './ExcerptChatDrawer.jsx';
import { UNTITLED_PROJECT } from './projectText.js';
import { useProjectView } from './useProjectView.js';
import { useProjectMerge } from './useProjectMerge.js';
import { browserScheduler } from '../shared/runtime/browserHosts.js';
import { ProjectTopicTree } from './ProjectTopicTree.jsx';
import './project-actions.css';

const NO_EXCERPTS = [];
const VIEWS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'topics', label: 'Topics tree' },
];

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
  const { status, view, error, refresh } = useProjectView({ projectId, api, subscribe, scheduler });
  const [chatOpen, setChatOpen] = useState(true);
  const [activeView, setActiveView] = useState('canvas');
  const {
    canMerge,
    pending: topicPending,
    notice: topicNotice,
    build: buildTopicTree,
    stop: stopTopicTree,
    open: openMerge,
  } = useProjectMerge({
    projectId,
    api,
    merge: view?.topicMerge,
    refresh,
    showTopics: () => setActiveView('topics'),
  });
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

  const acknowledgeFocus = useCallback(
    (excerptId) => {
      // A lost acknowledgement only means the request is offered again.
      Promise.resolve(api.acknowledgeExcerptFocus?.(projectId, excerptId)).catch(() => {});
    },
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
  const topicActions = canMerge
    ? [
        {
          id: 'merge-primary-topics',
          label: 'Merge similar topics',
          description:
            'Group primary topics across the project’s saved pages and read their sources together.',
          disabled: topicPending,
          onSelect: openMerge,
        },
      ]
    : [];
  const topicTreeOpen = canMerge && activeView === 'topics';
  return (
    <div className="project-shell">
      <ProjectHeader
        project={view.project}
        isOpen={view.isOpen}
        tabCount={tabs.length}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
        actions={topicActions}
        viewTabs={
          canMerge && (
            <div className="project-view-tabs" role="tablist" aria-label="Project views">
              {VIEWS.map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`project-tab-${id}`}
                  aria-controls={`project-panel-${id}`}
                  aria-selected={activeView === id}
                  onClick={() => setActiveView(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          )
        }
      />
      <div className="project-body">
        <div className="project-canvas-wrap">
          <div
            hidden={topicTreeOpen}
            role="tabpanel"
            id="project-panel-canvas"
            aria-labelledby="project-tab-canvas"
            className={
              topicTreeOpen ? 'project-canvas-content is-hidden' : 'project-canvas-content'
            }
          >
            <ProjectCanvas
              active={!topicTreeOpen}
              tabs={tabs}
              excerpts={view.excerpts || NO_EXCERPTS}
              focusExcerptId={view.focusExcerptId || null}
              onFocusHandled={api.acknowledgeExcerptFocus ? acknowledgeFocus : undefined}
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
          {topicTreeOpen && (
            <div
              className="project-topics-content"
              role="tabpanel"
              id="project-panel-topics"
              aria-labelledby="project-tab-topics"
            >
              <ProjectTopicTree
                project={view.project}
                merge={view.topicMerge}
                pending={topicPending}
                notice={topicNotice}
                onBuild={buildTopicTree}
                onStop={stopTopicTree}
              />
            </div>
          )}
        </div>
        {chatOpen && (
          <ProjectChatPanel
            projectId={projectId}
            merge={view.topicMerge}
            onOpenMerge={canMerge ? openMerge : undefined}
            onCollapse={() => setChatOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
