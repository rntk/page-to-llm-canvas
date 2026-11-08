import { useCallback, useEffect, useRef, useState } from 'react';
import { isTypingTarget } from '../utils/isTypingTarget.js';
import { DEFAULT_VIEWPORT, wheelZoomFactor, zoomViewport } from './canvasLayout.js';

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

const ARROW_PAN = {
  ArrowUp: [0, 80],
  ArrowDown: [0, -80],
  ArrowLeft: [80, 0],
  ArrowRight: [-80, 0],
};
const NAV_KEYS = ['Home', 'End', 'PageUp', 'PageDown'];

/**
 * Pan/zoom state and input handling for the canvas surface: surface-drag
 * panning, wheel zoom, keyboard navigation, and the pointer-gesture tracker
 * shared with card dragging.
 *
 * @param {{active: boolean}} options `active` enables keyboard navigation.
 * @returns {{
 *   viewport: {x: number, y: number, zoom: number},
 *   viewportRef: {current: {x: number, y: number, zoom: number}},
 *   surfaceRef: {current: HTMLElement|null},
 *   beginGesture: function(PointerEvent, function(number, number): void): void,
 *   handleSurfacePointerDown: function(PointerEvent): void,
 *   zoomFromCenter: function(number): void,
 *   resetViewport: function(): void,
 * }}
 */
export function useCanvasViewport({ active }) {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);
  const surfaceRef = useRef(null);
  const viewportRef = useRef(viewport);
  useEffect(() => {
    viewportRef.current = viewport;
  }, [viewport]);
  const stopGestureRef = useRef(null);

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
      const pan = ARROW_PAN[event.key];
      if (!pan && !NAV_KEYS.includes(event.key)) return;
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
        if (pan) return { ...current, x: current.x + pan[0], y: current.y + pan[1] };
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

  const zoomFromCenter = useCallback((factor) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    setViewport((current) =>
      zoomViewport(current, factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2),
    );
  }, []);

  const resetViewport = useCallback(() => setViewport(DEFAULT_VIEWPORT), []);

  const handleSurfacePointerDown = (event) => {
    if (event.button !== 0 || event.target.closest('.canvas-node')) return;
    event.preventDefault();
    const origin = viewportRef.current;
    beginGesture(event, (dx, dy) => setViewport({ ...origin, x: origin.x + dx, y: origin.y + dy }));
  };

  return {
    viewport,
    viewportRef,
    surfaceRef,
    beginGesture,
    handleSurfacePointerDown,
    zoomFromCenter,
    resetViewport,
  };
}
