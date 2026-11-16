import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

// Top inset restored when the reading column is (re)centered from scratch.
const TOP_MARGIN = 40;
// Dead-zone: the column's center may drift ±this fraction of the viewport width
// before being nudged back, so small layout shifts don't move the canvas.
const COMFORT_DEAD_ZONE_RATIO = 0.15;
// Column edges must stay at least this far inside the viewport.
const EDGE_MARGIN = 24;
// Ignore sub-pixel corrections (no-op transforms).
const MIN_DELTA = 0.5;

/**
 * Where the reading column's left edge should sit, in wrap-local px.
 *
 * Moves by the minimum delta to re-enter the center dead-zone, keeping both
 * edges within `EDGE_MARGIN`; a near-center column is untouched.
 * @param {number} currentLeft Current column left edge.
 * @param {number} columnWidth Column width.
 * @param {number} wrapWidth Viewport width.
 */
export function computeComfortLeft(currentLeft, columnWidth, wrapWidth) {
  // Too wide to center: only pull back when the left edge has scrolled off-screen.
  if (columnWidth >= wrapWidth - 2 * EDGE_MARGIN) {
    if (currentLeft < 0) return EDGE_MARGIN;
    return currentLeft;
  }

  const minLeft = EDGE_MARGIN;
  const maxLeft = wrapWidth - EDGE_MARGIN - columnWidth;
  const wrapCenter = wrapWidth / 2;
  const columnCenter = currentLeft + columnWidth / 2;
  const deadZone = wrapWidth * COMFORT_DEAD_ZONE_RATIO;

  let nextLeft = currentLeft;
  if (Math.abs(columnCenter - wrapCenter) > deadZone) {
    const sign = columnCenter > wrapCenter ? 1 : -1;
    const targetCenter = wrapCenter + sign * deadZone;
    nextLeft = targetCenter - columnWidth / 2;
  }
  return Math.min(Math.max(nextLeft, minLeft), maxLeft);
}

/**
 * Keeps layout-affecting changes (mode, level, rail toggles) from jumping the canvas,
 * using the reading column (`anchorRef`) as the anchor:
 *  - Continuity: `captureAnchor()` records the column's screen position before the
 *    change, then an instant pan restores it (FLIP).
 *  - Comfort: if the column left the dead-zone, a smooth move one frame later
 *    (via `flashFocus`) nudges it back by the minimum.
 *
 * Runs only on `deps` changes and initial load (centers, pins top margin), never
 * during manual panning/zooming.
 *
 * @param {object} params
 * @param {object} params.anchorRef
 * @param {object} params.viewport
 * @param {object} params.viewport.canvasWrapElRef
 * @param {object} params.viewport.scaleRef
 * @param {object} params.viewport.translateRef
 * @param {function(number, {x: number, y: number}): void} params.viewport.setTransformNow
 * @param {function(): void} [params.flashFocus]
 * @param {ReadonlyArray<unknown>} params.deps
 * @returns {{captureAnchor: function(boolean=): void, skipNextAlignment: function(): void}}
 */
export function useCanvasAlignment({ anchorRef, viewport, flashFocus, deps }) {
  // The wrap element is this hook's measurement frame (hence `wrapElRef`).
  const { canvasWrapElRef: wrapElRef, setTransformNow, translateRef, scaleRef } = viewport;
  // Column's pre-change position, captured by callers before a layout-affecting
  // update. `resetTop` resets vertical position to the top margin instead of
  // preserving it (wholesale content swap, i.e. summary-mode toggle).
  const pendingAnchorRef = useRef(null);
  // Last-aligned deps: continuity runs only on a real change, initial center once.
  const stateRef = useRef({ inited: false, deps: null });
  // Pending rAF for the deferred (animated) comfort/reset move.
  const moveRafRef = useRef(0);
  // Next deps change is positioned by someone else (e.g. zoom-to-sentence); skip alignment.
  const skipNextRef = useRef(false);

  const skipNextAlignment = useCallback(() => {
    skipNextRef.current = true;
  }, []);

  const captureAnchor = useCallback(
    (resetTop = false) => {
      const anchor = anchorRef.current;
      const wrap = wrapElRef.current;
      if (!anchor || !wrap) return;
      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      if (wrapRect.width === 0) return;
      pendingAnchorRef.current = {
        left: anchorRect.left - wrapRect.left,
        top: anchorRect.top - wrapRect.top,
        resetTop,
      };
    },
    [anchorRef, wrapElRef],
  );

  const align = useCallback(
    (isInitial) => {
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
      const anchor = anchorRef.current;
      const wrap = wrapElRef.current;
      if (!anchor || !wrap) return;
      const wrapRect = wrap.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      // Not laid out yet (e.g. jsdom, or a hidden tab): nothing to measure.
      if (wrapRect.width === 0 || anchorRect.width === 0) return;

      const anchorLeft = anchorRect.left - wrapRect.left;
      const anchorTop = anchorRect.top - wrapRect.top;
      const columnWidth = anchorRect.width;

      const panTo = (left, top) => {
        const dx = left - anchorLeft;
        const dy = top - anchorTop;
        if (Math.abs(dx) < MIN_DELTA && Math.abs(dy) < MIN_DELTA) return false;
        setTransformNow(scaleRef.current || 1, {
          x: translateRef.current.x + dx,
          y: translateRef.current.y + dy,
        });
        return true;
      };

      // Initial: center and pin the top margin in one instant move.
      if (isInitial) {
        panTo(computeComfortLeft(anchorLeft, columnWidth, wrapRect.width), TOP_MARGIN);
        return;
      }

      const captured = pendingAnchorRef.current;
      pendingAnchorRef.current = null;

      // Baseline = pre-switch position. On a swap (`resetTop`) the vertical
      // baseline stays put; the top reset joins the animated move below.
      const baseLeft = captured ? captured.left : anchorLeft;
      const baseTop = captured && !captured.resetTop ? captured.top : anchorTop;

      // Final = baseline gently re-centered (x), top margin restored on a swap.
      const finalLeft = computeComfortLeft(baseLeft, columnWidth, wrapRect.width);
      const finalTop = captured && captured.resetTop ? TOP_MARGIN : baseTop;

      // Step 1: instant, pre-paint continuity pan cancelling the reflow.
      panTo(baseLeft, baseTop);

      // Step 2: animated re-center / top reset, deferred a frame so the slide
      // starts from the jump-free position.
      if (Math.abs(finalLeft - baseLeft) < MIN_DELTA && Math.abs(finalTop - baseTop) < MIN_DELTA) {
        return;
      }
      moveRafRef.current = requestAnimationFrame(() => {
        moveRafRef.current = 0;
        if (flashFocus) flashFocus();
        const a = anchorRef.current;
        const w = wrapElRef.current;
        if (!a || !w) return;
        const wRect = w.getBoundingClientRect();
        const aRect = a.getBoundingClientRect();
        if (wRect.width === 0 || aRect.width === 0) return;
        const curLeft = aRect.left - wRect.left;
        const curTop = aRect.top - wRect.top;
        const dx = finalLeft - curLeft;
        const dy = finalTop - curTop;
        if (Math.abs(dx) < MIN_DELTA && Math.abs(dy) < MIN_DELTA) return;
        setTransformNow(scaleRef.current || 1, {
          x: translateRef.current.x + dx,
          y: translateRef.current.y + dy,
        });
      });
    },
    [anchorRef, wrapElRef, setTransformNow, translateRef, scaleRef, flashFocus],
  );

  // Wrap padding commits with scale, so align before paint from settled geometry.
  useLayoutEffect(() => {
    const prev = stateRef.current;
    const depsKey = JSON.stringify(deps);
    if (!prev.inited) {
      stateRef.current = { inited: true, deps: depsKey };
      align(true);
      return;
    }
    if (prev.deps === depsKey) {
      // Re-ran without a real switch (e.g. setState was a no-op): drop the stale
      // capture so the next genuine switch doesn't consume it.
      pendingAnchorRef.current = null;
      return;
    }
    stateRef.current = { inited: true, deps: depsKey };
    if (skipNextRef.current) {
      // Another controller (zoom-to-sentence) positions this switch. Deps are
      // recorded so the next one still aligns; drop stale capture and pending move.
      skipNextRef.current = false;
      pendingAnchorRef.current = null;
      if (moveRafRef.current) {
        cancelAnimationFrame(moveRafRef.current);
        moveRafRef.current = 0;
      }
      return;
    }
    align(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [align, ...deps]);

  // Cancel any in-flight animated move on unmount.
  useEffect(
    () => () => {
      if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    },
    [],
  );

  return { captureAnchor, skipNextAlignment };
}
