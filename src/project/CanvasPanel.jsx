import React, { useCallback } from 'react';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { PageChatDrawer } from './PageChatDrawer.jsx';
import { ExcerptChatDrawer } from './ExcerptChatDrawer.jsx';

const NO_EXCERPTS = [];

/**
 * Keeps the canvas mounted across view switches and connects its per-card actions.
 * @param {object} props
 * @param {object} props.view
 * @param {function(number): Promise<{source: object}>} props.loadSource
 * @param {function(number): Promise<{sentences: string[]}>} props.capture
 * @param {function(string): Promise<{sentences: string[]}>} props.readPage
 * @param {function(string): Promise<*>} props.deleteExcerpt
 * @param {function(string): Promise<*>} props.acknowledgeFocus
 * @param {object} props.tabsHost
 * @param {import('./useChatEvidence.js').ChatEvidence[]} [props.chatEvidence] The project chat's evidence card.
 * @param {function(string): void} [props.onDismissChatEvidence]
 * @param {boolean} props.active
 */
export function CanvasPanel({
  view,
  loadSource,
  capture,
  readPage,
  deleteExcerpt,
  acknowledgeFocus,
  tabsHost,
  chatEvidence,
  onDismissChatEvidence,
  active,
}) {
  const renderPageChat = useCallback(
    (tab, { id, onClose }) => (
      <PageChatDrawer
        drawerId={id}
        tab={tab}
        loadSource={loadSource}
        capture={capture}
        onClose={onClose}
      />
    ),
    [loadSource, capture],
  );
  const renderExcerptChat = useCallback(
    (excerpt, { id, onClose }) => (
      <ExcerptChatDrawer drawerId={id} excerpt={excerpt} readPage={readPage} onClose={onClose} />
    ),
    [readPage],
  );
  const handleDeleteExcerpt = useCallback((excerpt) => deleteExcerpt(excerpt.id), [deleteExcerpt]);
  const handleFocus = useCallback(
    (excerptId) => {
      // A lost acknowledgement only means the request is offered again.
      Promise.resolve(acknowledgeFocus(excerptId)).catch(() => {});
    },
    [acknowledgeFocus],
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
        chatEvidence={chatEvidence}
        onDismissChatEvidence={onDismissChatEvidence}
        focusExcerptId={view.focusExcerptId || null}
        onFocusHandled={handleFocus}
        tabsHost={tabsHost}
        renderPageChat={renderPageChat}
        renderExcerptChat={renderExcerptChat}
        onDeleteExcerpt={handleDeleteExcerpt}
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
