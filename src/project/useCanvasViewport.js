import { isCanvasShortcutEvent } from '../utils/isCanvasShortcutEvent.js';
import { useCallback, useEffect, useRef } from 'react';
import { isTypingTarget } from '../utils/isTypingTarget.js';
import { ARROW_PAN, horizontalWheelPan, pagePanStep } from '../utils/canvasMath.js';
import { trackPointer } from '../utils/trackPointer.js';
import { DEFAULT_VIEWPORT, wheelZoomFactor, zoomViewport } from './canvasLayout.js';

// Chat drawers and excerpt text scroll (and chats take keys) on their own, so
// canvas wheel-zoom and keyboard panning leave them alone.
// These data attributes describe input behavior independently of styling.
const CHAT_SELECTOR = '[data-canvas-chat]';
const SCROLLABLE_SELECTOR = '[data-canvas-scroll]';
const NODE_SELECTOR = '[data-canvas-node]';

function insideSelector(target, selector) {
  return typeof target?.closest === 'function' && !!target.closest(selector);
}

const NAV_KEYS = ['Home', 'End', 'PageUp', 'PageDown'];

/**
 * Pan/zoom state and input handling for the canvas surface: surface-drag
 * panning, wheel zoom, keyboard navigation, and the pointer-gesture tracker
 * shared with card dragging.
 *
 * @param {{active: boolean}} options `active` enables keyboard navigation.
 * @returns {{
 *   viewportRef: {current: {x: number, y: number, zoom: number}},
 *   layerRef: {current: HTMLElement|null},
 *   zoomLabelRef: {current: HTMLElement|null},
 *   surfaceRef: {current: HTMLElement|null},
 *   beginGesture: function(PointerEvent, function(number, number): void): void,
 *   handleSurfacePointerDown: function(PointerEvent): void,
 *   zoomFromCenter: function(number): void,
 *   resetViewport: function(): void,
 * }}
 */
export function useCanvasViewport({ active }) {
  const surfaceRef = useRef(null);
  const layerRef = useRef(null);
  const zoomLabelRef = useRef(null);
  const viewportRef = useRef(DEFAULT_VIEWPORT);
  const frameRef = useRef(null);
  const stopGestureRef = useRef(null);

  const applyViewport = useCallback(() => {
    const { x, y, zoom } = viewportRef.current;
    if (surfaceRef.current) {
      surfaceRef.current.style.backgroundSize = `${24 * zoom}px ${24 * zoom}px`;
      surfaceRef.current.style.backgroundPosition = `${x}px ${y}px`;
    }
    if (layerRef.current) {
      layerRef.current.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`;
    }
    if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${Math.round(zoom * 100)}%`;
  }, []);

  // Update input coordinates immediately and paint at most once per frame.
  const setViewport = useCallback(
    (update, scheduled = false) => {
      viewportRef.current = typeof update === 'function' ? update(viewportRef.current) : update;
      if (scheduled) {
        if (frameRef.current === null) {
          frameRef.current = window.requestAnimationFrame(() => {
            frameRef.current = null;
            applyViewport();
          });
        }
      } else {
        if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        applyViewport();
      }
    },
    [applyViewport],
  );

  const beginGesture = useCallback((event, onMove, onEnd) => {
    stopGestureRef.current?.();
    const stop = trackPointer(event, onMove, () => {
      stopGestureRef.current = null;
      onEnd?.();
    });
    stopGestureRef.current = () => {
      stop();
      onEnd?.();
    };
  }, []);

  useEffect(
    () => () => {
      stopGestureRef.current?.();
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

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
      // A sideways swipe pans instead of zooming.
      const panX = horizontalWheelPan(event, rect.width);
      if (panX) {
        setViewport((current) => ({ ...current, x: current.x + panX }), true);
        return;
      }
      setViewport(
        (current) =>
          zoomViewport(
            current,
            wheelZoomFactor(event.deltaY, event.deltaMode, rect.height),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        true,
      );
    };
    surface.addEventListener('wheel', handleWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleWheel);
  }, [setViewport]);

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = (event) => {
      if (
        !isCanvasShortcutEvent(event) ||
        isTypingTarget(event.target) ||
        insideSelector(event.target, CHAT_SELECTOR)
      )
        return;
      const pan = ARROW_PAN[event.key];
      if (!pan && !NAV_KEYS.includes(event.key)) return;
      event.preventDefault();
      const surface = surfaceRef.current;
      const height = surface?.clientHeight || 0;
      const pageStep = pagePanStep(height);
      // Measure live bounds so End includes cards dragged beyond the grid.
      const nodes = event.key === 'End' ? [...surface.querySelectorAll(NODE_SELECTOR)] : [];
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
  }, [active, setViewport]);

  const zoomFromCenter = useCallback(
    (factor) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      setViewport((current) =>
        zoomViewport(current, factor, (rect?.width ?? 0) / 2, (rect?.height ?? 0) / 2),
      );
    },
    [setViewport],
  );

  const resetViewport = useCallback(() => setViewport(DEFAULT_VIEWPORT), [setViewport]);

  const handleSurfacePointerDown = (event) => {
    if (event.button !== 0 || insideSelector(event.target, NODE_SELECTOR)) return;
    event.preventDefault();
    const origin = viewportRef.current;
    beginGesture(
      event,
      (dx, dy) => setViewport({ ...origin, x: origin.x + dx, y: origin.y + dy }, true),
      () => setViewport(viewportRef.current),
    );
  };

  return {
    viewportRef,
    layerRef,
    zoomLabelRef,
    surfaceRef,
    beginGesture,
    handleSurfacePointerDown,
    zoomFromCenter,
    resetViewport,
  };
}
