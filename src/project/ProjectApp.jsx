import React, { useMemo, useState } from 'react';
import { bindProjectApi } from './bindProjectApi.js';
import { CanvasPanel } from './CanvasPanel.jsx';
import { ProjectViewTabs } from './ProjectViewTabs.jsx';
import { useDocumentTitle } from './useDocumentTitle.js';
import { ProjectChatPanel } from './ProjectChatPanel.jsx';
import { ProjectHeader } from './ProjectHeader.jsx';
import { UNTITLED_PROJECT } from './projectText.js';
import { useProjectView } from './useProjectView.js';
import { useProjectMerge } from './useProjectMerge.js';
import { ProjectTopicTree } from './ProjectTopicTree.jsx';
import './project-actions.css';

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
 * @param {import('./projectsApi.js').ProjectsApi} props.api
 * @param {function(function(): void, {scope?: object}=): function(): void} [props.subscribe]
 *   Change subscription (see `subscribeProjectChanges`).
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 * @param {{openOptions: function(): void}} props.pageHost
 * @param {{setTimeout: function, clearTimeout: function}} [props.scheduler]
 */
export function ProjectApp({ projectId, api, subscribe, tabsHost, pageHost, scheduler }) {
  const projectApi = useMemo(() => bindProjectApi(api, projectId), [api, projectId]);
  const { status, view, error, refresh } = useProjectView({ projectId, api, subscribe, scheduler });
  const [chatOpen, setChatOpen] = useState(true);
  const [activeView, setActiveView] = useState('canvas');
  const {
    actions: topicActions,
    pending: topicPending,
    notice: topicNotice,
    build: buildTopicTree,
    stop: stopTopicTree,
    open: openMerge,
  } = useProjectMerge({
    buildTopics: projectApi.buildTopics,
    stopTopics: projectApi.stopTopics,
    merge: view?.topicMerge,
    refresh,
    showTopics: () => setActiveView('topics'),
  });
  useDocumentTitle(view ? `${view.project.title || UNTITLED_PROJECT} · Project` : null);

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
  const topicTreeOpen = activeView === 'topics';
  return (
    <div className="project-shell">
      <ProjectHeader
        project={view.project}
        isOpen={view.isOpen}
        tabCount={tabs.length}
        chatOpen={chatOpen}
        onToggleChat={() => setChatOpen((open) => !open)}
        actions={topicActions}
        viewTabs={<ProjectViewTabs activeView={activeView} onSelect={setActiveView} />}
      />
      <div className="project-body">
        <div className="project-canvas-wrap">
          <CanvasPanel
            key={projectId}
            view={view}
            loadSource={projectApi.loadSource}
            capture={projectApi.capture}
            readPage={projectApi.readPage}
            deleteExcerpt={projectApi.deleteExcerpt}
            acknowledgeFocus={projectApi.acknowledgeFocus}
            tabsHost={tabsHost}
            active={!topicTreeOpen}
          />
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
            onOpenMerge={openMerge}
            onCollapse={() => setChatOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
