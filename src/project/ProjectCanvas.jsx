import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget } from '../utils/isTypingTarget.js';
import { canonicalPageUrl } from '../core/storage/keys.js';
import { ExcerptCard } from './ExcerptCard.jsx';
import { TabCard } from './TabCard.jsx';
import {
  DEFAULT_VIEWPORT,
  ZOOM_STEP,
  excerptConnectorPath,
  layoutProjectCanvas,
  wheelZoomFactor,
  zoomViewport,
} from './canvasLayout.js';

/**
 * Follows a pointer gesture on the window until release.
 * @param {PointerEvent} start
 * @param {function(number, number): void} onMove Receives total dx, dy in px.
 * @returns {function(): void} Cancel (also called on release).
 */
function trackPointer(start, onMove) {
  const { clientX: x0, clientY: y0 } = start;
  const handleMove = (event) => onMove(event.clientX - x0, event.clientY - y0);
  const stop = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
  return stop;
}

// Chat drawers and excerpt text scroll (and chats take keys) on their own, so
// canvas wheel-zoom and keyboard panning leave them alone.
const PAGE_CHAT_SELECTOR = '.page-chat-drawer';
const SCROLLABLE_SELECTOR = `${PAGE_CHAT_SELECTOR}, .excerpt-card-text`;

function insideSelector(target, selector) {
  return typeof target?.closest === 'function' && !!target.closest(selector);
}

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

const excerptNodeKey = (excerptId) => `excerpt:${excerptId}`;
const NO_EXCERPTS = [];

/**
 * Pairs each excerpt with the first tab showing its page (fragment ignored).
 * @param {object[]} tabs
 * @param {object[]} excerpts
 * @returns {{pageOf: Map<string, object>, byPage: Record<string, string[]>, orphans: string[]}}
 */
function linkExcerpts(tabs, excerpts) {
  const tabByUrl = new Map();
  for (const tab of tabs) {
    const url = canonicalPageUrl(tab.url);
    if (url && !tabByUrl.has(url)) tabByUrl.set(url, tab);
  }
  const pageOf = new Map();
  const byPage = {};
  const orphans = [];
  for (const excerpt of excerpts) {
    const key = excerptNodeKey(excerpt.id);
    const tab = tabByUrl.get(canonicalPageUrl(excerpt.url));
    if (!tab) {
      orphans.push(key);
      continue;
    }
    pageOf.set(excerpt.id, tab);
    (byPage[tab.id] ||= []).push(key);
  }
  return { pageOf, byPage, orphans };
}

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
  active = true,
}) {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [moved, setMoved] = useState({});
  const [topId, setTopId] = useState(null);
  const [openChats, setOpenChats] = useState(() => new Set());
  const [handledFocus, setHandledFocus] = useState(null);
  const surfaceRef = useRef(null);
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const stopGestureRef = useRef(null);

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

  const beginGesture = useCallback((event, onMove) => {
    stopGestureRef.current?.();
    stopGestureRef.current = trackPointer(event, onMove);
  }, []);

  useEffect(() => () => stopGestureRef.current?.(), []);

  // React registers wheel listeners as passive, so preventDefault (needed to
  // stop browser page-zoom on Ctrl/⌘+wheel) requires a native listener.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return undefined;
    const handleWheel = (event) => {
      // Plain wheel over a chat or excerpt scrolls it; Ctrl/⌘+wheel still zooms.
      if (insideSelector(event.target, SCROLLABLE_SELECTOR) && !event.ctrlKey && !event.metaKey) {
        return;
      }
      event.preventDefault();
      const rect = surface.getBoundingClientRect();
      setViewport((current) =>
        zoomViewport(
          current,
          wheelZoomFactor(event.deltaY, event.deltaMode, rect.height),
          event.clientX - rect.left,
          event.clientY - rect.top,
        ),
      );
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target) || insideSelector(event.target, PAGE_CHAT_SELECTOR)) return;
      const arrows = {
        ArrowUp: [0, 80],
        ArrowDown: [0, -80],
        ArrowLeft: [80, 0],
        ArrowRight: [-80, 0],
      };
      if (!arrows[event.key] && !['Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
      event.preventDefault();
      const surface = surfaceRef.current;
      const height = surface?.clientHeight || 0;
      const pageStep = Math.max(120, height * 0.8);
      // Measure live bounds so End includes cards dragged beyond the grid.
      const nodes = event.key === 'End' ? [...surface.querySelectorAll('.canvas-node')] : [];
      const surfaceTop = surface.getBoundingClientRect().top;
      const bottom = nodes.length
        ? Math.max(...nodes.map((node) => node.getBoundingClientRect().bottom - surfaceTop))
        : viewportRef.current.y;
      setViewport((current) => {
        if (arrows[event.key]) {
          const [dx, dy] = arrows[event.key];
          return { ...current, x: current.x + dx, y: current.y + dy };
        }
        const y =
          event.key === 'Home'
            ? 40
            : event.key === 'End'
              ? Math.min(40, height - (bottom - current.y) - 40)
              : current.y + (event.key === 'PageUp' ? pageStep : -pageStep);
        return { ...current, y };
      });
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active]);

  const zoomFromCenter = (factor) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    setViewport((current) =>
      zoomViewport(current, factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2),
    );
  };

  const handleSurfacePointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('.canvas-node')) return;
    event.preventDefault();
    const origin = viewportRef.current;
    beginGesture(event, (dx, dy) => setViewport({ ...origin, x: origin.x + dx, y: origin.y + dy }));
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
        <button type="button" onClick={() => setViewport(DEFAULT_VIEWPORT)}>
          Reset view
        </button>
      </div>
    </div>
  );
}
