import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTypingTarget } from '../utils/isTypingTarget.js';
import { TabCard } from './TabCard.jsx';
import {
  DEFAULT_VIEWPORT,
  ZOOM_STEP,
  layoutGrid,
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

/**
 * Pannable, zoomable surface with draggable tab cards. Card positions are kept
 * in component state only (keyed by tab id): they reset when the page reloads.
 *
 * @param {object} props
 * @param {object[]} props.tabs
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 */
export function ProjectCanvas({ tabs, tabsHost }) {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const [moved, setMoved] = useState({});
  const [topId, setTopId] = useState(null);
  const surfaceRef = useRef(null);
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const stopGestureRef = useRef(null);

  const grid = useMemo(() => layoutGrid(tabs.map((tab) => tab.id)), [tabs]);

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
    const handleKeyDown = (event) => {
      if (isTypingTarget(event.target)) return;
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
  }, []);

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

  const startCardDrag = (tabId, event) => {
    if (event.button !== 0) return;
    const start = moved[tabId] || grid[tabId];
    const zoom = viewportRef.current.zoom;
    setTopId(tabId);
    beginGesture(event, (dx, dy) =>
      setMoved((current) => ({
        ...current,
        [tabId]: { x: start.x + dx / zoom, y: start.y + dy / zoom },
      })),
    );
  };

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
          {tabs.map((tab) => {
            const position = moved[tab.id] || grid[tab.id];
            return (
              <div
                key={tab.id}
                className="canvas-node"
                style={{
                  transform: `translate(${position.x}px, ${position.y}px)`,
                  zIndex: tab.id === topId ? 2 : 1,
                }}
              >
                <TabCard
                  tab={tab}
                  tabsHost={tabsHost}
                  onDragStart={(event) => startCardDrag(tab.id, event)}
                />
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
