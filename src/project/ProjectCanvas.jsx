import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ExcerptCard } from './ExcerptCard.jsx';
import { TabCard } from './TabCard.jsx';
import { ZOOM_STEP, excerptConnectorPath, layoutProjectCanvas } from './canvasLayout.js';
import { excerptNodeKey, linkExcerpts } from './excerptLinks.js';
import { useCanvasViewport } from './useCanvasViewport.js';

/**
 * Tab-like button on the right edge of a card (or of its unfolded chat) that
 * folds and unfolds the card's chat.
 * @param {object} props
 * @param {string} props.name What the chat is about, for its accessible name.
 * @param {string} props.hint Tooltip while folded.
 * @param {boolean} props.open
 * @param {function(): void} props.onToggle
 */
function ChatFold({ name, hint, open, onToggle }) {
  return (
    <button
      type="button"
      className="page-chat-fold"
      aria-expanded={open}
      aria-label={`${open ? 'Fold' : 'Unfold'} chat for ${name}`}
      title={open ? 'Fold chat' : hint}
      onClick={onToggle}
    >
      {open ? '‹ Chat' : 'Chat ›'}
    </button>
  );
}

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
 * @param {function(object, {onClose: function(): void}): import('react').ReactNode} [props.renderPageChat]
 *   Renders a tab's chat drawer; without it cards have no chat fold.
 * @param {function(object, {onClose: function(): void}): import('react').ReactNode} [props.renderExcerptChat]
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
    viewport,
    viewportRef,
    surfaceRef,
    beginGesture,
    handleSurfacePointerDown,
    zoomFromCenter,
    resetViewport,
  } = useCanvasViewport({ active });
  const [moved, setMoved] = useState({});
  const [topId, setTopId] = useState(null);
  const [openChats, setOpenChats] = useState(() => new Set());
  const [handledFocus, setHandledFocus] = useState(null);

  // A newly opened excerpt unfolds its chat above the other cards. Adjusted
  // during render, so it applies in the same pass that first shows the card.
  if (focusExcerptId && focusExcerptId !== handledFocus) {
    setHandledFocus(focusExcerptId);
    if (renderExcerptChat && excerpts.some((excerpt) => excerpt.id === focusExcerptId)) {
      const key = excerptNodeKey(focusExcerptId);
      setOpenChats((current) => new Set(current).add(key));
      setTopId(key);
    }
  }

  // Reported once per focus id; the callback's identity is irrelevant.
  useEffect(() => {
    if (focusExcerptId && focusExcerptId === handledFocus) onFocusHandled?.(focusExcerptId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusExcerptId, handledFocus]);

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

  const pagePosition = (tabId) => moved[tabId] || layout.pages[tabId];
  const excerptPosition = (excerptId) => {
    const key = excerptNodeKey(excerptId);
    if (moved[key]) return moved[key];
    const slot = layout.excerpts[key];
    const page = links.pageOf.get(excerptId);
    if (!page) return { x: slot.x, y: slot.y };
    const origin = pagePosition(page.id);
    return { x: origin.x + slot.dx, y: origin.y + slot.dy };
  };

  const startDrag = (key, start, event) => {
    if (event.button !== 0) return;
    const zoom = viewportRef.current.zoom;
    setTopId(key);
    beginGesture(event, (dx, dy) =>
      setMoved((current) => ({
        ...current,
        [key]: { x: start.x + dx / zoom, y: start.y + dy / zoom },
      })),
    );
  };

  const setChatOpen = useCallback((key, open) => {
    setOpenChats((current) => {
      if (current.has(key) === open) return current;
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
    if (open) setTopId(key);
  }, []);

  // An unfolded chat overlaps its neighbours, so keep it above them.
  const nodeZIndex = (key, chatOpen) => (key === topId ? 3 : chatOpen ? 2 : 1);

  const { x, y, zoom } = viewport;
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
              <div
                key={tab.id}
                className="canvas-node"
                style={{
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  zIndex: nodeZIndex(tab.id, chatOpen),
                }}
                onPointerDown={() => {
                  if (chatOpen) setTopId(tab.id);
                }}
              >
                <TabCard
                  tab={tab}
                  tabsHost={tabsHost}
                  onDragStart={(event) => startDrag(tab.id, position, event)}
                />
                {chatOpen && renderPageChat(tab, { onClose: () => setChatOpen(tab.id, false) })}
                {renderPageChat && (
                  <ChatFold
                    name={tab.title || tab.url || 'this page'}
                    hint="Chat about this page"
                    open={chatOpen}
                    onToggle={() => setChatOpen(tab.id, !chatOpen)}
                  />
                )}
              </div>
            );
          })}
          {excerpts.map((excerpt) => {
            const key = excerptNodeKey(excerpt.id);
            const position = excerptPosition(excerpt.id);
            const page = links.pageOf.get(excerpt.id) || null;
            const chatOpen = !!renderExcerptChat && openChats.has(key);
            return (
              <div
                key={key}
                className="canvas-node"
                style={{
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  zIndex: nodeZIndex(key, chatOpen),
                }}
                onPointerDown={() => {
                  if (chatOpen) setTopId(key);
                }}
              >
                <ExcerptCard
                  excerpt={excerpt}
                  page={page}
                  tabsHost={tabsHost}
                  onDelete={() => onDeleteExcerpt?.(excerpt)}
                  onDragStart={(event) => startDrag(key, position, event)}
                />
                {chatOpen && renderExcerptChat(excerpt, { onClose: () => setChatOpen(key, false) })}
                {renderExcerptChat && (
                  <ChatFold
                    name={`the excerpt from ${page?.title || excerpt.title || excerpt.url}`}
                    hint="Chat about this excerpt"
                    open={chatOpen}
                    onToggle={() => setChatOpen(key, !chatOpen)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="canvas-controls" role="group" aria-label="Canvas zoom">
        <button type="button" onClick={() => zoomFromCenter(1 / ZOOM_STEP)} aria-label="Zoom out">
          −
        </button>
        <span className="canvas-zoom-level" aria-live="polite">
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
