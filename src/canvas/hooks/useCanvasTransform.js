import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clampScale, cursorAnchoredTranslate } from '../../utils/canvasMath.js';

const WHEEL_IN = 1.1;
const WHEEL_OUT = 1 / 1.1;
const ARROW_STEP = 80;

/**
 * Simplified canvas transform hook: pan, wheel zoom, programmatic zoom,
 * page navigation, and arrow/Home/End/PageUp/PageDown keyboard shortcuts.
 *
 * Returns render state (`translate`/`scale` and the drag/focus flags, which must
 * stay flat so consumers re-render when they change) plus a single `viewport`
 * handle carrying the imperative surface — the live transform refs and the
 * move-the-canvas callbacks — for the hooks that drive the canvas rather than
 * draw it. See the `viewport` memo below for why it is bundled.
 */
export function useCanvasTransform({ contentRef } = {}) {
  const [translate, setTranslate] = useState({ x: 40, y: 40 });
  const [scale, setScale] = useState(1);
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  const [isFocusingHighlight, setIsFocusingHighlight] = useState(false);
  // Distinct from `isFocusingHighlight` (a purely visual focus glow that any
  // pan/zoom flashes). This flips true only for an actual zoom-to-target, where
  // the *scale* changes mid-transition; sentence measurement must be suppressed
  // until it settles. Keeping it separate means ordinary pan (mouse/keyboard)
  // no longer recreates the measurement callback and re-runs the expensive
  // remeasure. It must be state, not a ref: the false-flip is what re-triggers
  // the post-settle remeasurement.
  const [isZoomingToTarget, setIsZoomingToTarget] = useState(false);

  // Callback refs so listeners can re-bind once the DOM mounts (the canvas
  // wrap is rendered conditionally on `isDone`, so it is null on first effect).
  const canvasWrapElRef = useRef(null);
  const canvasViewportElRef = useRef(null);
  const [canvasWrapEl, setCanvasWrapEl] = useState(null);
  const [canvasViewportEl, setCanvasViewportEl] = useState(null);
  const canvasWrapRef = useCallback((el) => {
    canvasWrapElRef.current = el;
    setCanvasWrapEl(el);
  }, []);
  const canvasViewportRef = useCallback((el) => {
    canvasViewportElRef.current = el;
    setCanvasViewportEl(el);
  }, []);

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 40, y: 40 });
  const userMovedCanvasRef = useRef(false);
  const rafRef = useRef(0);
  const pendingRef = useRef(null);
  const focusTimerRef = useRef(null);
  const zoomingTimerRef = useRef(null);
  // Drag pan writes the transform imperatively (CSS vars + translateRef) on a
  // dedicated rAF, bypassing React state so a mouse drag does not re-render the
  // whole canvas tree ~60fps. State is committed once on mouse-up.
  const dragRafRef = useRef(0);
  const dragPendingRef = useRef(null);

  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useEffect(() => {
    translateRef.current = translate;
  }, [translate]);

  const setTransformNow = useCallback((nextScale, nextTranslate) => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    pendingRef.current = null;
    scaleRef.current = nextScale;
    translateRef.current = nextTranslate;
    setScale(nextScale);
    setTranslate(nextTranslate);
  }, []);

  const scheduleTransform = useCallback((nextScale, nextTranslate) => {
    scaleRef.current = nextScale;
    translateRef.current = nextTranslate;
    pendingRef.current = { scale: nextScale, translate: nextTranslate };
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (!pending) return;
      setScale(pending.scale);
      setTranslate(pending.translate);
    });
  }, []);

  const flashFocus = useCallback(() => {
    setIsFocusingHighlight(true);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => setIsFocusingHighlight(false), 380);
  }, []);

  // Mark a zoom-to-target as in flight so sentence measurement is suppressed
  // until the (≈320ms) transform transition settles. The false-flip drives the
  // post-settle remeasure, so the timing must outlast the transition; mirror
  // flashFocus's 380ms.
  const flashZoomingToTarget = useCallback(() => {
    setIsZoomingToTarget(true);
    if (zoomingTimerRef.current) clearTimeout(zoomingTimerRef.current);
    zoomingTimerRef.current = setTimeout(() => setIsZoomingToTarget(false), 380);
  }, []);

  // Apply a translate directly to the DOM + ref without touching React state.
  // Used by the drag-pan rAF; `translate` state is only read by the CSS-var
  // layout effect, so writing the vars here keeps the canvas in sync while
  // avoiding a render storm. State is reconciled on mouse-up.
  const applyTranslateImperative = useCallback((next) => {
    translateRef.current = next;
    const viewportEl = canvasViewportElRef.current;
    if (viewportEl) {
      viewportEl.style.setProperty('--canvas-translate-x', `${next.x}px`);
      viewportEl.style.setProperty('--canvas-translate-y', `${next.y}px`);
    }
  }, []);

  // CSS variable sync on the viewport. Runs in a layout effect (synchronously
  // after commit, before paint) so the transform is applied before any
  // post-transform measurement — notably the zoom-to-target re-pin below, which
  // reads the settled layout in a requestAnimationFrame.
  useLayoutEffect(() => {
    if (!canvasViewportEl) return;
    canvasViewportEl.style.setProperty('--canvas-translate-x', `${translate.x}px`);
    canvasViewportEl.style.setProperty('--canvas-translate-y', `${translate.y}px`);
    canvasViewportEl.style.setProperty('--canvas-scale', `${scale}`);
  }, [canvasViewportEl, scale, translate.x, translate.y]);

  // Track the canvas wrap's height so sticky titles can clamp to the
  // visible viewport (the sticky CSS reads --canvas-area-height).
  useEffect(() => {
    if (!canvasViewportEl || !canvasWrapEl) return undefined;
    const update = () => {
      canvasViewportEl.style.setProperty('--canvas-area-height', `${canvasWrapEl.clientHeight}px`);
    };
    update();
    if (typeof window.ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new window.ResizeObserver(update);
    ro.observe(canvasWrapEl);
    return () => ro.disconnect();
  }, [canvasViewportEl, canvasWrapEl]);

  // Body cursor while dragging.
  useEffect(() => {
    if (isCanvasDragging) document.body.classList.add('canvas-global-dragging');
    else document.body.classList.remove('canvas-global-dragging');
    return () => document.body.classList.remove('canvas-global-dragging');
  }, [isCanvasDragging]);

  // Mouse drag pan.
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });
  const handleMouseDown = useCallback(
    (e) => {
      if (e.button !== 0) return;
      setIsFocusingHighlight(false);
      setIsCanvasDragging(true);
      isDragging.current = true;
      userMovedCanvasRef.current = true;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      const onMove = (mv) => {
        if (!isDragging.current) return;
        const dx = mv.clientX - lastMouse.current.x;
        const dy = mv.clientY - lastMouse.current.y;
        lastMouse.current = { x: mv.clientX, y: mv.clientY };
        // Accumulate from the last *pending* target (not translateRef, which
        // only updates once per rAF) so multiple moves within a frame compose.
        const base = dragPendingRef.current || translateRef.current;
        dragPendingRef.current = { x: base.x + dx, y: base.y + dy };
        if (dragRafRef.current) return;
        dragRafRef.current = window.requestAnimationFrame(() => {
          dragRafRef.current = 0;
          const pending = dragPendingRef.current;
          dragPendingRef.current = null;
          if (pending) applyTranslateImperative(pending);
        });
      };
      const onUp = () => {
        isDragging.current = false;
        setIsCanvasDragging(false);
        if (dragRafRef.current) {
          window.cancelAnimationFrame(dragRafRef.current);
          dragRafRef.current = 0;
        }
        const pending = dragPendingRef.current;
        dragPendingRef.current = null;
        if (pending) applyTranslateImperative(pending);
        // Reconcile React state with the ref so the CSS-var layout effect won't
        // later overwrite the imperatively-set vars with a stale translate.
        setTransformNow(scaleRef.current || 1, translateRef.current);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [applyTranslateImperative, setTransformNow],
  );

  // Wheel zoom (re-binds when the wrap element mounts).
  useEffect(() => {
    if (!canvasWrapEl) return undefined;
    const handleWheel = (e) => {
      e.preventDefault();
      const currentScale = scaleRef.current || 1;
      const delta = e.deltaY > 0 ? WHEEL_OUT : WHEEL_IN;
      const nextScale = clampScale(currentScale * delta);
      if (nextScale === currentScale) return;
      const wrapRect = canvasWrapEl.getBoundingClientRect();
      const nextTranslate = cursorAnchoredTranslate({
        cursor: { x: e.clientX - wrapRect.left, y: e.clientY - wrapRect.top },
        translate: translateRef.current,
        currentScale,
        nextScale,
      });
      setIsFocusingHighlight(false);
      userMovedCanvasRef.current = true;
      scheduleTransform(nextScale, nextTranslate);
    };
    canvasWrapEl.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvasWrapEl.removeEventListener('wheel', handleWheel);
  }, [canvasWrapEl, scheduleTransform]);

  const panBy = useCallback(
    (dx, dy) => {
      userMovedCanvasRef.current = true;
      setTransformNow(scaleRef.current || 1, {
        x: translateRef.current.x + dx,
        y: translateRef.current.y + dy,
      });
      flashFocus();
    },
    [flashFocus, setTransformNow],
  );

  const navigateCanvas = useCallback(
    (pos) => {
      const wrap = canvasWrapElRef.current;
      if (!wrap) return;
      const viewportHeight = wrap.clientHeight || 0;
      const pageStep = Math.max(120, viewportHeight * 0.8);
      const topY = 40;
      const currentTranslate = translateRef.current;
      const currentScale = scaleRef.current || 1;
      let nextY = currentTranslate.y;
      if (pos === 'top') {
        nextY = topY;
      } else if (pos === 'bottom') {
        const viewportEl = canvasViewportElRef.current;
        const content = contentRef?.current;
        if (viewportEl && content) {
          const bottom =
            content.getBoundingClientRect().bottom - viewportEl.getBoundingClientRect().top;
          nextY = Math.min(topY, viewportHeight - bottom - topY);
        } else {
          nextY = currentTranslate.y - pageStep;
        }
      } else if (pos === 'prev') {
        nextY = currentTranslate.y + pageStep;
      } else if (pos === 'next') {
        nextY = currentTranslate.y - pageStep;
      }
      userMovedCanvasRef.current = true;
      setTransformNow(currentScale, { ...currentTranslate, y: nextY });
      flashFocus();
    },
    [contentRef, flashFocus, setTransformNow],
  );

  // Keyboard navigation: arrows pan, Home/End/PageUp/PageDown navigate.
  useEffect(() => {
    const onKeyDown = (e) => {
      const t = e.target;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t?.isContentEditable) {
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        navigateCanvas('top');
      } else if (e.key === 'End') {
        e.preventDefault();
        navigateCanvas('bottom');
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        navigateCanvas('prev');
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        navigateCanvas('next');
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        panBy(0, ARROW_STEP);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        panBy(0, -ARROW_STEP);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        panBy(ARROW_STEP, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        panBy(-ARROW_STEP, 0);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigateCanvas, panBy]);

  const zoomToTarget = useCallback(
    (targetRect, zoomLevel = 1.4) => {
      const wrap = canvasWrapElRef.current;
      const viewportEl = canvasViewportElRef.current;
      if (!wrap || !viewportEl || !targetRect) return;
      const wrapRect = wrap.getBoundingClientRect();
      const viewportRect = viewportEl.getBoundingClientRect();
      const currentScale = scaleRef.current || 1;
      const nextScale = clampScale(Math.max(currentScale, zoomLevel));
      const localTargetY =
        (targetRect.top + targetRect.height / 2 - viewportRect.top) / currentScale;
      let nextX;
      const content = contentRef?.current;
      if (content) {
        const localContentX =
          (content.getBoundingClientRect().left - viewportRect.left) / currentScale;
        nextX = 40 - localContentX * nextScale;
      } else {
        const localTargetX =
          (targetRect.left + targetRect.width / 2 - viewportRect.left) / currentScale;
        nextX = wrapRect.width / 2 - localTargetX * nextScale;
      }
      const nextY = wrapRect.height * 0.2 - localTargetY * nextScale;

      userMovedCanvasRef.current = true;
      setTransformNow(nextScale, {
        x: nextX,
        y: nextY,
      });
      flashFocus();
      // Scale changes here; suppress sentence measurement until the transition
      // settles (see isZoomingToTarget). Pan paths deliberately do not call this.
      flashZoomingToTarget();

      // The article column's left offset is zoom-adjusted: the summary gutter
      // and rail cards are sized 1/scale so they stay screen-constant, which
      // makes the article's local-x a function of `scale`. `nextX` above was
      // computed from the pre-zoom layout, so when the new scale reflows (e.g.
      // zooming in from a zoomed-out state collapses the inflated gutter) the
      // article slides sideways and the zoom lands on the rail instead of the
      // sentence. Re-pin the content's left edge from the *settled* layout once
      // the reflow has happened. Scale is unchanged here, so this is a pure pan
      // and triggers no further reflow.
      if (content) {
        window.requestAnimationFrame(() => {
          const settledViewport = canvasViewportElRef.current;
          if (!settledViewport) return;
          const settledViewportRect = settledViewport.getBoundingClientRect();
          const settledContentLeft = content.getBoundingClientRect().left;
          // `flashFocus()` adds a 320ms `transform` transition, so this rAF runs
          // while the viewport is still animating toward `nextScale` — the rects
          // above are mid-flight at the *old* scale. But the transform is shared
          // by both elements, so `(contentLeft - viewportLeft)` always equals
          // `contentLocalLeft * appliedScale` at every instant of the animation.
          // The layout (gutter width) is already settled, so dividing by the
          // scale actually applied to the DOM recovers the transform-invariant
          // local left, which we then re-pin at `nextScale`. (Reading the
          // animated rect without this division pins to the old scale's layout,
          // shifting the article sideways — badly on large zoom jumps.)
          const appliedScale =
            new DOMMatrixReadOnly(window.getComputedStyle(settledViewport).transform).a ||
            nextScale;
          const localContentLeft = (settledContentLeft - settledViewportRect.left) / appliedScale;
          const correctedX = 40 - localContentLeft * nextScale;
          if (Math.abs(correctedX - (translateRef.current?.x ?? nextX)) < 0.5) return;
          setTransformNow(scaleRef.current || nextScale, {
            x: correctedX,
            y: translateRef.current?.y ?? nextY,
          });
        });
      }
    },
    [contentRef, flashFocus, flashZoomingToTarget, setTransformNow],
  );

  // The imperative viewport handle: everything a consumer needs to *read* the
  // live transform (the refs, which stay current between renders) or *move* it,
  // bundled so it travels as one concept instead of six props threaded through
  // App. Deliberately excludes render state (`scale`/`translate`/flags), which
  // consumers must take flat so they re-render on change.
  //
  // Deps are the callbacks only: the four `useRef` containers are created once
  // and are stable for the component's lifetime, so listing them would add
  // nothing. That keeps the handle's identity flipping if and only if a callback
  // member changes — i.e. never in practice, since both are `useCallback`s over
  // stable deps — so effects keyed on `viewport` re-run exactly as often as
  // effects keyed on the individual members did.
  const viewport = useMemo(
    () => ({
      scaleRef,
      translateRef,
      canvasWrapElRef,
      userMovedCanvasRef,
      setTransformNow,
      zoomToTarget,
    }),
    [setTransformNow, zoomToTarget],
  );

  // Clean up the focus/zoom timers on unmount.
  useEffect(
    () => () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (zoomingTimerRef.current) clearTimeout(zoomingTimerRef.current);
    },
    [],
  );

  return {
    translate,
    scale,
    isCanvasDragging,
    isFocusingHighlight,
    isZoomingToTarget,
    canvasWrapRef,
    canvasViewportRef,
    canvasViewportElRef,
    handleMouseDown,
    navigateCanvas,
    flashFocus,
    viewport,
  };
}
