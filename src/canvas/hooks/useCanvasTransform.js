import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clampScale, cursorAnchoredTranslate } from '../../utils/canvasMath.js';
import { isTypingTarget } from '../../utils/isTypingTarget.js';

// Exponential scaling preserves trackpad precision across event frequencies.
const WHEEL_ZOOM_SENSITIVITY = 0.0008;
const MAX_WHEEL_DELTA_PX = 240;
const WHEEL_COMMIT_DELAY = 80;
// Outlast the 280ms CSS transition to avoid snapping its final frame.
const CARD_ZOOM_SMOOTHING_HOLD = 340;
const ARROW_STEP = 80;
// Keep the canvas content this far inside the viewport edges. Mirrors the
// alignment hook's margin of the same name.
const EDGE_MARGIN = 24;
// Fallback left edge (wrap-local px) used only when nothing can be measured.
const FALLBACK_CONTENT_LEFT = 40;
// Ignore sub-pixel corrections so we never schedule a no-op transform.
const MIN_DELTA = 0.5;

/**
 * Scale actually applied to an element right now.
 *
 * Use the applied matrix during transitions; target scale would skew DOM rects.
 * @param {Element} el Measured element.
 * @param {number} fallbackScale Fallback scale when no matrix is available.
 */
function readAppliedScale(el, fallbackScale) {
  try {
    const matrix = new DOMMatrixReadOnly(window.getComputedStyle(el).transform);
    return matrix.a || fallbackScale;
  } catch (_) {
    // `transform: none`, or no DOMMatrixReadOnly (older/jsdom-ish hosts).
    return fallbackScale;
  }
}

/**
 * Where the canvas content should sit horizontally after a zoom-to-target.
 *
 * Compute absolute placement from settled layout because inverse-scaled gutters
 * reflow on zoom. Frame the full group when it fits; otherwise frame the reading
 * column or pin its left edge inside the viewport.
 *
 * @param {{localContentLeft: number, columnLayoutWidth: number,
 *          groupLayoutWidth: number, nextScale: number, wrapWidth: number}} params
 * @returns {number} translate.x
 */
function zoomPinnedTranslateX({
  localContentLeft,
  columnLayoutWidth,
  groupLayoutWidth,
  nextScale,
  wrapWidth,
}) {
  const scaledLeft = localContentLeft * nextScale;
  if (!(wrapWidth > 0)) return FALLBACK_CONTENT_LEFT - scaledLeft;
  const usableWidth = wrapWidth - 2 * EDGE_MARGIN;

  // The group is the viewport's only child and begins at local x=0.
  const groupWidth = groupLayoutWidth * nextScale;
  if (groupWidth > 0 && groupWidth <= usableWidth) return (wrapWidth - groupWidth) / 2;

  const columnWidth = columnLayoutWidth * nextScale;
  if (!(columnWidth > 0)) return FALLBACK_CONTENT_LEFT - scaledLeft;
  const targetLeft = columnWidth >= usableWidth ? EDGE_MARGIN : (wrapWidth - columnWidth) / 2;
  return targetLeft - scaledLeft;
}

/**
 * Simplified canvas transform hook: pan, wheel zoom, programmatic zoom,
 * page navigation, and arrow/Home/End/PageUp/PageDown keyboard shortcuts.
 *
 * Returns render state (`translate`/`scale` and the drag/focus flags, which must
 * stay flat so consumers re-render when they change) plus a single `viewport`
 * handle carrying the imperative surface — the live transform refs and the
 * move-the-canvas callbacks — for the hooks that drive the canvas rather than
 * draw it. See the `viewport` memo below for why it is bundled.
 * @param {object} [options] Hook options.
 * @param {object} [options.contentRef]
 * @param {(scale: number) => void} [options.onVisualScaleChange]
 */
export function useCanvasTransform({ contentRef, onVisualScaleChange } = {}) {
  const [translate, setTranslate] = useState({ x: 40, y: 40 });
  const [scale, setScale] = useState(1);
  const [isCanvasDragging, setIsCanvasDragging] = useState(false);
  // Keep label smoothing active past mouse-up; removing its CSS class snaps mid-glide labels.
  const [isPanSmoothing, setIsPanSmoothing] = useState(false);
  const [isFocusingHighlight, setIsFocusingHighlight] = useState(false);
  const [isCardZoomSmoothing, setIsCardZoomSmoothing] = useState(false);
  // Suppress sentence measurement only during target zoom; state retriggers it on settle.
  const [isZoomingToTarget, setIsZoomingToTarget] = useState(false);

  // Callback refs so listeners can re-bind once the canvas DOM mounts.
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
  const wheelCommitTimerRef = useRef(null);
  const cardZoomSmoothingTimerRef = useRef(null);
  // Preserve the reading surface's screen position when zoom commits gutter reflow.
  const pendingScaleLayoutAnchorRef = useRef(null);
  const focusTimerRef = useRef(null);
  const zoomingTimerRef = useRef(null);
  const panSettleTimerRef = useRef(null);
  // Set by zoomToTarget when its placement must be redone once the new scale's
  // layout has committed; consumed by the layout effect below.
  const pendingZoomPinRef = useRef(null);
  // Pan imperatively per frame; commit React state on mouse-up.
  const dragRafRef = useRef(0);
  const dragPendingRef = useRef(null);
  // Unmount must detach drag listeners if mouse-up never arrives.
  const dragDetachRef = useRef(null);

  const setTransformNow = useCallback((nextScale, nextTranslate) => {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    if (wheelCommitTimerRef.current) {
      clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = null;
    }
    pendingRef.current = null;
    pendingScaleLayoutAnchorRef.current = null;
    scaleRef.current = nextScale;
    translateRef.current = nextTranslate;
    setScale(nextScale);
    setTranslate(nextTranslate);
  }, []);

  const captureScaleLayoutAnchor = useCallback(
    (nextScale, nextTranslate, reuseCurrentLayout = false) => {
      const viewportEl = canvasViewportElRef.current;
      const content = contentRef?.current;
      if (!viewportEl || !content) return null;

      let localContentX;
      let localContentY;
      const currentAnchor = pendingScaleLayoutAnchorRef.current;
      if (reuseCurrentLayout && currentAnchor) {
        ({ localContentX, localContentY } = currentAnchor);
      } else {
        const viewportRect = viewportEl.getBoundingClientRect();
        const contentRect = content.getBoundingClientRect();
        const appliedScale = readAppliedScale(viewportEl, scaleRef.current || 1);
        localContentX = (contentRect.left - viewportRect.left) / appliedScale;
        localContentY = (contentRect.top - viewportRect.top) / appliedScale;
      }

      return {
        scale: nextScale,
        localContentX,
        localContentY,
        targetContentX: nextTranslate.x + localContentX * nextScale,
        targetContentY: nextTranslate.y + localContentY * nextScale,
      };
    },
    [contentRef],
  );

  const startCardZoomSmoothing = useCallback(() => {
    setIsCardZoomSmoothing(true);
    if (cardZoomSmoothingTimerRef.current) clearTimeout(cardZoomSmoothingTimerRef.current);
    cardZoomSmoothingTimerRef.current = setTimeout(() => {
      cardZoomSmoothingTimerRef.current = null;
      setIsCardZoomSmoothing(false);
    }, CARD_ZOOM_SMOOTHING_HOLD);
  }, []);

  const stopCardZoomSmoothing = useCallback(() => {
    if (cardZoomSmoothingTimerRef.current) {
      clearTimeout(cardZoomSmoothingTimerRef.current);
      cardZoomSmoothingTimerRef.current = null;
    }
    canvasViewportElRef.current?.classList.remove('is-card-zoom-smoothing');
    setIsCardZoomSmoothing(false);
  }, []);

  // Apply wheel zoom to CSS per frame, then reconcile React after the input burst.
  const scheduleTransform = useCallback(
    (nextScale, nextTranslate) => {
      pendingScaleLayoutAnchorRef.current = captureScaleLayoutAnchor(
        nextScale,
        nextTranslate,
        true,
      );
      scaleRef.current = nextScale;
      translateRef.current = nextTranslate;
      pendingRef.current = { scale: nextScale, translate: nextTranslate };
      if (rafRef.current) return;
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = 0;
        const pending = pendingRef.current;
        pendingRef.current = null;
        if (!pending) return;
        const viewportEl = canvasViewportElRef.current;
        if (viewportEl) {
          viewportEl.style.setProperty('--canvas-translate-x', `${pending.translate.x}px`);
          viewportEl.style.setProperty('--canvas-translate-y', `${pending.translate.y}px`);
          viewportEl.style.setProperty('--canvas-scale', `${pending.scale}`);
        }
        onVisualScaleChange?.(pending.scale);

        // Correct translation in the same frame if inverse-scaled gutters reflow.
        const layoutAnchor = pendingScaleLayoutAnchorRef.current;
        const content = contentRef?.current;
        if (layoutAnchor && viewportEl && content) {
          const viewportRect = viewportEl.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          const appliedScale = readAppliedScale(viewportEl, pending.scale);
          const localContentX = (contentRect.left - viewportRect.left) / appliedScale;
          const localContentY = (contentRect.top - viewportRect.top) / appliedScale;
          const correctedTranslate = {
            x: layoutAnchor.targetContentX - localContentX * pending.scale,
            y: layoutAnchor.targetContentY - localContentY * pending.scale,
          };
          layoutAnchor.localContentX = localContentX;
          layoutAnchor.localContentY = localContentY;
          translateRef.current = correctedTranslate;
          viewportEl.style.setProperty('--canvas-translate-x', `${correctedTranslate.x}px`);
          viewportEl.style.setProperty('--canvas-translate-y', `${correctedTranslate.y}px`);
        }
      });

      if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = setTimeout(() => {
        wheelCommitTimerRef.current = null;
        const committedScale = scaleRef.current;
        const committedTranslate = translateRef.current;
        setScale(committedScale);
        setTranslate(committedTranslate);
      }, WHEEL_COMMIT_DELAY);
    },
    [captureScaleLayoutAnchor, contentRef, onVisualScaleChange],
  );

  const zoomAtPoint = useCallback(
    (cursor, nextScale) => {
      const currentScale = scaleRef.current || 1;
      const clampedScale = clampScale(nextScale);
      if (clampedScale === currentScale) return;
      const nextTranslate = cursorAnchoredTranslate({
        cursor,
        translate: translateRef.current,
        currentScale,
        nextScale: clampedScale,
      });
      const layoutAnchor = captureScaleLayoutAnchor(clampedScale, nextTranslate);
      userMovedCanvasRef.current = true;
      startCardZoomSmoothing();
      setTransformNow(clampedScale, nextTranslate);
      pendingScaleLayoutAnchorRef.current = layoutAnchor;
    },
    [captureScaleLayoutAnchor, setTransformNow, startCardZoomSmoothing],
  );

  const flashFocus = useCallback(() => {
    setIsFocusingHighlight(true);
    if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
    focusTimerRef.current = setTimeout(() => setIsFocusingHighlight(false), 380);
  }, []);

  // Outlast the transform transition before allowing sentence measurement again.
  const flashZoomingToTarget = useCallback(() => {
    setIsZoomingToTarget(true);
    if (zoomingTimerRef.current) clearTimeout(zoomingTimerRef.current);
    zoomingTimerRef.current = setTimeout(() => setIsZoomingToTarget(false), 380);
  }, []);

  // Update DOM and ref during drag; reconcile React state on mouse-up.
  const applyTranslateImperative = useCallback((next) => {
    translateRef.current = next;
    const viewportEl = canvasViewportElRef.current;
    if (viewportEl) {
      viewportEl.style.setProperty('--canvas-translate-x', `${next.x}px`);
      viewportEl.style.setProperty('--canvas-translate-y', `${next.y}px`);
    }
  }, []);

  // Sync CSS before the later zoom placement effect measures the viewport.
  useLayoutEffect(() => {
    if (!canvasViewportEl) return;
    // A wheel frame may already be ahead of the deferred React commit. Never
    // let that older commit overwrite the newer compositor transform.
    if (
      scale !== scaleRef.current ||
      translate.x !== translateRef.current.x ||
      translate.y !== translateRef.current.y
    ) {
      return;
    }
    canvasViewportEl.style.setProperty('--canvas-translate-x', `${translate.x}px`);
    canvasViewportEl.style.setProperty('--canvas-translate-y', `${translate.y}px`);
    canvasViewportEl.style.setProperty('--canvas-scale', `${scale}`);
  }, [canvasViewportEl, scale, translate.x, translate.y]);

  // Sync inverse-scaled cards with the compositor without per-frame React renders.
  useLayoutEffect(() => {
    onVisualScaleChange?.(scale);
  }, [onVisualScaleChange, scale]);

  // Correct gutter reflow before paint to preserve cursor-anchored placement.
  useLayoutEffect(() => {
    const anchor = pendingScaleLayoutAnchorRef.current;
    if (!anchor || anchor.scale !== scale) return;
    pendingScaleLayoutAnchorRef.current = null;

    const viewportEl = canvasViewportElRef.current;
    const content = contentRef?.current;
    if (!viewportEl || !content) return;
    const viewportRect = viewportEl.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const appliedScale = readAppliedScale(viewportEl, scale);
    const localContentX = (contentRect.left - viewportRect.left) / appliedScale;
    const localContentY = (contentRect.top - viewportRect.top) / appliedScale;
    const nextTranslate = {
      x: anchor.targetContentX - localContentX * scale,
      y: anchor.targetContentY - localContentY * scale,
    };
    const currentTranslate = translateRef.current;
    if (
      Math.abs(nextTranslate.x - currentTranslate.x) < MIN_DELTA &&
      Math.abs(nextTranslate.y - currentTranslate.y) < MIN_DELTA
    ) {
      return;
    }
    setTransformNow(scale, nextTranslate);
  }, [contentRef, scale, setTransformNow]);

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
      // Cancel stale settle timers before a new drag can lose its smoothing class.
      if (panSettleTimerRef.current) clearTimeout(panSettleTimerRef.current);
      if (cardZoomSmoothingTimerRef.current) clearTimeout(cardZoomSmoothingTimerRef.current);
      setIsPanSmoothing(true);
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
        // Keep smoothing past the final 130ms label transition.
        if (panSettleTimerRef.current) clearTimeout(panSettleTimerRef.current);
        panSettleTimerRef.current = setTimeout(() => setIsPanSmoothing(false), 200);
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
        detach();
      };
      const detach = () => {
        dragDetachRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      // A second mousedown without an intervening mouseup (the button released
      // outside the document, say) would otherwise strand the first pair.
      dragDetachRef.current?.();
      dragDetachRef.current = detach;
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [applyTranslateImperative, setTransformNow],
  );

  // Wheel zoom (re-binds when the wrap element mounts).
  useEffect(() => {
    if (!canvasWrapEl) return undefined;
    let wrapRect = canvasWrapEl.getBoundingClientRect();
    const refreshWrapRect = () => {
      wrapRect = canvasWrapEl.getBoundingClientRect();
    };
    const resizeObserver =
      typeof window.ResizeObserver === 'undefined'
        ? null
        : new window.ResizeObserver(refreshWrapRect);
    resizeObserver?.observe(canvasWrapEl);
    const handleWheel = (e) => {
      e.preventDefault();
      stopCardZoomSmoothing();
      const currentScale = scaleRef.current || 1;
      // Normalize pixel, line, and page deltas before applying the zoom curve.
      const deltaPixels =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? e.deltaY * 16
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? e.deltaY * Math.max(1, wrapRect.height)
            : e.deltaY;
      const boundedDelta = Math.max(-MAX_WHEEL_DELTA_PX, Math.min(MAX_WHEEL_DELTA_PX, deltaPixels));
      const nextScale = clampScale(currentScale * Math.exp(-boundedDelta * WHEEL_ZOOM_SENSITIVITY));
      if (nextScale === currentScale) return;
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
    window.addEventListener('resize', refreshWrapRect);
    window.addEventListener('scroll', refreshWrapRect, true);
    return () => {
      canvasWrapEl.removeEventListener('wheel', handleWheel);
      window.removeEventListener('resize', refreshWrapRect);
      window.removeEventListener('scroll', refreshWrapRect, true);
      resizeObserver?.disconnect();
    };
  }, [canvasWrapEl, scheduleTransform, stopCardZoomSmoothing]);

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
      if (isTypingTarget(e.target)) return;
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
      // A prior zoom may still be animating; use its applied scale for DOM rects.
      const appliedScale = readAppliedScale(viewportEl, currentScale);
      const localTargetY =
        (targetRect.top + targetRect.height / 2 - viewportRect.top) / appliedScale;
      let nextX;
      const content = contentRef?.current;
      if (content) {
        const localContentX =
          (content.getBoundingClientRect().left - viewportRect.left) / appliedScale;
        nextX = zoomPinnedTranslateX({
          localContentLeft: localContentX,
          // offsetWidth is layout px (transform-free), so it needs no unscaling.
          columnLayoutWidth: content.offsetWidth,
          // The viewport must have only the gutter/column/rail group as its child.
          groupLayoutWidth: viewportRect.width / appliedScale,
          nextScale,
          wrapWidth: wrapRect.width,
        });
      } else {
        const localTargetX =
          (targetRect.left + targetRect.width / 2 - viewportRect.left) / appliedScale;
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

      // Inverse-scaled gutters change the landing layout; replace provisional
      // placement after a scale commit.
      if (content && nextScale !== currentScale) pendingZoomPinRef.current = { scale: nextScale };
    },
    [contentRef, flashFocus, flashZoomingToTarget, setTransformNow],
  );

  // Place target zoom from the settled layout before paint.
  useLayoutEffect(() => {
    const pending = pendingZoomPinRef.current;
    // Wait for the commit that carries the zoom's scale; ignore every other
    // transform change (wheel, drag, pan), which must not be re-placed.
    if (!pending || pending.scale !== scale) return;
    pendingZoomPinRef.current = null;

    const wrap = canvasWrapElRef.current;
    const viewportEl = canvasViewportElRef.current;
    const content = contentRef?.current;
    if (!wrap || !viewportEl || !content) return;
    const wrapRect = wrap.getBoundingClientRect();
    const viewportRect = viewportEl.getBoundingClientRect();
    if (wrapRect.width === 0) return;

    // Undo the currently applied transform to recover layout coordinates.
    const appliedScale = readAppliedScale(viewportEl, scale);
    const localContentLeft =
      (content.getBoundingClientRect().left - viewportRect.left) / appliedScale;
    const nextX = zoomPinnedTranslateX({
      localContentLeft,
      columnLayoutWidth: content.offsetWidth,
      groupLayoutWidth: viewportRect.width / appliedScale,
      nextScale: scale,
      wrapWidth: wrapRect.width,
    });
    if (Math.abs(nextX - (translateRef.current?.x ?? 0)) < MIN_DELTA) return;
    // Pure horizontal pan at an unchanged scale: no further reflow, so this
    // settles in one pass.
    setTransformNow(scale, { x: nextX, y: translateRef.current?.y ?? 0 });
  }, [contentRef, scale, setTransformNow]);

  // Stable imperative handle for live transform reads and movement. Render state
  // remains separate so consumers update when scale or flags change.
  const viewport = useMemo(
    () => ({
      scaleRef,
      translateRef,
      canvasWrapElRef,
      userMovedCanvasRef,
      setTransformNow,
      zoomAtPoint,
      zoomToTarget,
      // Exposed because zoomToTarget is not the only way to commit an animated
      // scale change: a view restore re-applies a remembered scale through
      // setTransformNow and needs the same measurement suppression.
      flashZoomingToTarget,
    }),
    [setTransformNow, zoomAtPoint, zoomToTarget, flashZoomingToTarget],
  );

  // Clean up every timer, pending frame and window-level drag listener on
  // unmount.
  useEffect(
    () => () => {
      if (focusTimerRef.current) clearTimeout(focusTimerRef.current);
      if (zoomingTimerRef.current) clearTimeout(zoomingTimerRef.current);
      if (panSettleTimerRef.current) clearTimeout(panSettleTimerRef.current);
      if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
      if (cardZoomSmoothingTimerRef.current) clearTimeout(cardZoomSmoothingTimerRef.current);
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      if (dragRafRef.current) window.cancelAnimationFrame(dragRafRef.current);
      dragDetachRef.current?.();
    },
    [],
  );

  return {
    translate,
    scale,
    isCanvasDragging,
    isPanSmoothing,
    isFocusingHighlight,
    isCardZoomSmoothing,
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
