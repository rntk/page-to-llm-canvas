import React, { useCallback } from 'react';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { PageChatDrawer } from './PageChatDrawer.jsx';
import { ExcerptChatDrawer } from './ExcerptChatDrawer.jsx';

const NO_EXCERPTS = [];

/**
 * Keeps the canvas mounted across view switches and connects its per-card actions.
 * @param {object} props
 * @param {string} props.projectId
 * @param {object} props.view
 * @param {import('../projects/projectsApi.js').ProjectsApi} props.api
 * @param {object} props.tabsHost
 * @param {boolean} props.active
 */
export function CanvasPanel({ projectId, view, api, tabsHost, active }) {
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
      Promise.resolve(api.acknowledgeExcerptFocus(projectId, excerptId)).catch(() => {});
    },
    [api, projectId],
  );

  return (
    <div
      hidden={!active}
      role="tabpanel"
      id="project-panel-canvas"
      aria-labelledby="project-tab-canvas"
      className={active ? 'project-canvas-content' : 'project-canvas-content is-hidden'}
    >
      <ProjectCanvas
        active={active}
        tabs={view.tabs}
        excerpts={view.excerpts || NO_EXCERPTS}
        focusExcerptId={view.focusExcerptId || null}
        onFocusHandled={acknowledgeFocus}
        tabsHost={tabsHost}
        renderPageChat={renderPageChat}
        renderExcerptChat={renderExcerptChat}
        onDeleteExcerpt={deleteExcerpt}
      />
      {!view.isOpen && (
        <p className="canvas-hint" role="status">
          This project&apos;s tab group is closed
        </p>
      )}
      {view.isOpen && view.tabs.length === 0 && (
        <p className="canvas-hint" role="status">
          Add tabs to this tab group to see them here
        </p>
      )}
    </div>
  );
}
