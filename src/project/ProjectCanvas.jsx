import React, { useMemo } from 'react';
import { ExcerptCard } from './ExcerptCard.jsx';
import { TabCard } from './TabCard.jsx';
import {
  DEFAULT_VIEWPORT,
  ZOOM_STEP,
  excerptConnectorPath,
  layoutProjectCanvas,
} from './canvasLayout.js';
import { excerptNodeKey, linkExcerpts } from './excerptLinks.js';
import { useCanvasViewport } from './useCanvasViewport.js';
import { CanvasNode } from './CanvasNode.jsx';
import { useNodePositions } from './useNodePositions.js';
import { useOpenChats } from './useOpenChats.js';
import { useExcerptFocus } from './useExcerptFocus.js';

const NO_EXCERPTS = [];

/**
 * Pannable, zoomable surface with draggable tab and excerpt cards. Excerpts
 * stack under the card of the page they were taken from, linked to it by a
 * connector, and follow it when it is dragged until dragged themselves. Card
 * positions and which chats are unfolded are kept in component state only
 * (keyed by tab id or excerpt node key): they reset when the page reloads.
 *
 * @param {object} props
 * @param {object[]} props.tabs
 * @param {object[]} [props.excerpts] The project's excerpts, oldest first.
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 * @param {function(object, {id: string, onClose: function(): void}): import('react').ReactNode} [props.renderPageChat]
 *   Renders a tab's chat drawer (`id` is the one its fold controls); without it
 *   cards have no chat fold.
 * @param {function(object, {id: string, onClose: function(): void}): import('react').ReactNode} [props.renderExcerptChat]
 *   Renders an excerpt's chat drawer; without it excerpt cards have no chat fold.
 * @param {function(object): Promise<*>} [props.onDeleteExcerpt]
 * @param {string|null} [props.focusExcerptId] Unfolds this excerpt's chat once.
 * @param {function(string): *} [props.onFocusHandled] Called once a focus id has been handled.
 * @param {boolean} [props.active] Enables keyboard navigation while this view is visible.
 */
export function ProjectCanvas({
  tabs,
  excerpts = NO_EXCERPTS,
  tabsHost,
  renderPageChat,
  renderExcerptChat,
  onDeleteExcerpt,
  focusExcerptId = null,
  onFocusHandled,
  active = true,
}) {
  const {
    layerRef,
    zoomLabelRef,
    viewportRef,
    surfaceRef,
    beginGesture,
    handleSurfacePointerDown,
    zoomFromCenter,
    resetViewport,
  } = useCanvasViewport({ active });
  const { openChats, setChatOpen, raiseNode, nodeZIndex } = useOpenChats();
  useExcerptFocus({ focusExcerptId, excerpts, renderExcerptChat, setChatOpen, onFocusHandled });

  const links = useMemo(() => linkExcerpts(tabs, excerpts), [tabs, excerpts]);
  const layout = useMemo(
    () =>
      layoutProjectCanvas(
        tabs.map((tab) => tab.id),
        links.byPage,
        links.orphans,
      ),
    [tabs, links],
  );

  const { pagePosition, excerptPosition, startDrag } = useNodePositions({
    layout,
    links,
    surfaceRef,
    viewportRef,
    beginGesture,
    raiseNode,
  });

  const { x, y, zoom } = DEFAULT_VIEWPORT;
  const dot = 24 * zoom;

  return (
    <div className="canvas-area">
      <div
        ref={surfaceRef}
        className="canvas-surface"
        data-testid="canvas-surface"
        style={{ backgroundSize: `${dot}px ${dot}px`, backgroundPosition: `${x}px ${y}px` }}
        onPointerDown={handleSurfacePointerDown}
      >
        <div
          ref={layerRef}
          className="canvas-layer"
          data-testid="canvas-layer"
          style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}
        >
          {links.pageOf.size > 0 && (
            <svg className="canvas-links" aria-hidden="true" width="1" height="1">
              {excerpts.map((excerpt) => {
                const page = links.pageOf.get(excerpt.id);
                if (!page) return null;
                return (
                  <path
                    key={excerpt.id}
                    className="excerpt-link"
                    data-excerpt-id={excerpt.id}
                    d={excerptConnectorPath(pagePosition(page.id), excerptPosition(excerpt.id))}
                  />
                );
              })}
            </svg>
          )}
          {tabs.map((tab) => {
            const position = pagePosition(tab.id);
            const chatOpen = !!renderPageChat && openChats.has(tab.id);
            return (
              <CanvasNode
                key={tab.id}
                nodeKey={tab.id}
                position={position}
                chatOpen={chatOpen}
                zIndex={nodeZIndex(tab.id, chatOpen)}
                raiseNode={raiseNode}
                setChatOpen={setChatOpen}
                renderChat={renderPageChat && ((options) => renderPageChat(tab, options))}
                foldName={tab.title || tab.url || 'this page'}
                foldHint="Chat about this page"
              >
                <TabCard
                  tab={tab}
                  tabsHost={tabsHost}
                  onDragStart={(event) => startDrag(tab.id, position, event)}
                />
              </CanvasNode>
            );
          })}
          {excerpts.map((excerpt) => {
            const key = excerptNodeKey(excerpt.id);
            const position = excerptPosition(excerpt.id);
            const page = links.pageOf.get(excerpt.id) || null;
            const chatOpen = !!renderExcerptChat && openChats.has(key);
            return (
              <CanvasNode
                key={key}
                nodeKey={key}
                position={position}
                chatOpen={chatOpen}
                zIndex={nodeZIndex(key, chatOpen)}
                raiseNode={raiseNode}
                setChatOpen={setChatOpen}
                renderChat={renderExcerptChat && ((options) => renderExcerptChat(excerpt, options))}
                foldName={`the excerpt from ${page?.title || excerpt.title || excerpt.url}`}
                foldHint="Chat about this excerpt"
              >
                <ExcerptCard
                  excerpt={excerpt}
                  page={page}
                  tabsHost={tabsHost}
                  onDelete={() => onDeleteExcerpt?.(excerpt)}
                  onDragStart={(event) => startDrag(key, position, event)}
                />
              </CanvasNode>
            );
          })}
        </div>
      </div>
      <div className="canvas-controls" role="group" aria-label="Canvas zoom">
        <button type="button" onClick={() => zoomFromCenter(1 / ZOOM_STEP)} aria-label="Zoom out">
          −
        </button>
        <span ref={zoomLabelRef} className="canvas-zoom-level" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" onClick={() => zoomFromCenter(ZOOM_STEP)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={resetViewport}>
          Reset view
        </button>
      </div>
    </div>
  );
}
