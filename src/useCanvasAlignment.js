import { useCallback, useLayoutEffect, useRef } from 'react';

// Top inset restored when the reading column is (re)centered from scratch.
const TOP_MARGIN = 40;
// The reading column's center may drift within ±this fraction of the viewport
// width before the comfort layer nudges it back. Acts as a dead-zone so small,
// expected layout shifts (e.g. a slightly narrower summary column) don't move
// the canvas.
const COMFORT_DEAD_ZONE_RATIO = 0.15;
// Column edges must stay at least this far inside the viewport; an edge past
// this line counts as "off-screen" and overrides the user-position grace.
const EDGE_MARGIN = 24;
// Ignore sub-pixel corrections so we never schedule a no-op transform.
const MIN_DELTA = 0.5;

/**
 * Decide where the reading column's left edge should sit, in wrap-local px.
 *
 * Keep the column inside a dead-zone around the viewport center, moving by the
 * *minimum* delta to re-enter the zone (not snapping to dead center) and always
 * keeping both edges within `EDGE_MARGIN`. The dead-zone is what makes this
 * "don't move when it isn't necessary": a column already near center is left
 * untouched. This only ever runs on a deliberate mode/level/rail switch (see
 * `align`), never during free pan/zoom, so it does not fight manual panning.
 */
export function computeComfortLeft(currentLeft, columnWidth, wrapWidth) {
  // Column wider than the comfortable viewport: centering is meaningless, so we
  // only ever pull it back when its left edge has actually scrolled off-screen
  // (past the viewport's left edge) — losing the start of the content.
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
 * Unified canvas alignment ("don't jump, stay roughly centered").
 *
 * The reading column (`anchorRef` — the article body or summary cards) is the
 * single anchor. Layout-affecting changes (summary-mode toggle, topic level,
 * rail visibility) rearrange the side cards and rail around it, which used to
 * make the canvas snap to a freshly recomputed center every time. Instead:
 *
 *  - Continuity (default): callers capture the column's on-screen position
 *    *before* the change via `captureAnchor()`; afterwards we pan so it lands
 *    in the same place (FLIP). A mode switch produces no perceived jump.
 *  - Comfort: only then, and only if the column drifted out of the dead-zone,
 *    do we nudge it back by the minimum amount (see `computeComfortLeft`).
 *
 * This runs only on a deliberate switch (the `deps` change) or the initial
 * center — never during free pan/zoom — so it never fights manual panning.
 *
 * The first time content is ready we have nothing to preserve, so we center the
 * column and pin it to the top margin.
 *
 * @param {{
 *   enabled: boolean,
 *   anchorRef: import('react').RefObject<HTMLElement>,
 *   wrapElRef: import('react').RefObject<HTMLElement>,
 *   setTransformNow: (scale: number, translate: {x: number, y: number}) => void,
 *   translateRef: import('react').RefObject<{x: number, y: number}>,
 *   scaleRef: import('react').RefObject<number>,
 *   deps: ReadonlyArray<unknown>,
 * }} params
 * @returns {{ captureAnchor: (resetTop?: boolean) => void }}
 */
export function useCanvasAlignment({
  enabled,
  anchorRef,
  wrapElRef,
  setTransformNow,
  translateRef,
  scaleRef,
  deps,
}) {
  // The column's pre-change screen position, recorded synchronously by callers
  // before they trigger a layout-affecting state update. `resetTop` requests
  // that vertical position be reset to the top margin instead of preserved
  // (used when the content swaps wholesale, i.e. summary-mode toggle).
  const pendingAnchorRef = useRef(null);
  // Tracks the deps we last aligned for, so we run continuity only on a real
  // change and the initial center exactly once.
  const stateRef = useRef({ inited: false, deps: null });

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

      const captured = pendingAnchorRef.current;
      pendingAnchorRef.current = null;

      // Continuity: start from where the column was on screen pre-change. With
      // no capture (initial center, or a programmatic trigger) start from its
      // current position and reset the top inset.
      let targetLeft;
      let targetTop;
      if (!isInitial && captured) {
        targetLeft = captured.left;
        targetTop = captured.resetTop ? TOP_MARGIN : captured.top;
      } else {
        targetLeft = anchorLeft;
        targetTop = TOP_MARGIN;
      }

      // Comfort: gentle, minimum re-centering toward the dead-zone.
      targetLeft = computeComfortLeft(targetLeft, columnWidth, wrapRect.width);

      const dx = targetLeft - anchorLeft;
      const dy = targetTop - anchorTop;
      if (Math.abs(dx) < MIN_DELTA && Math.abs(dy) < MIN_DELTA) return;
      setTransformNow(scaleRef.current || 1, {
        x: translateRef.current.x + dx,
        y: translateRef.current.y + dy,
      });
    },
    [anchorRef, wrapElRef, setTransformNow, translateRef, scaleRef],
  );

  // Layout effect (synchronous, pre-paint): the reading column's left edge is a
  // function of the wrap padding, which is set inline from `scale` in the same
  // commit, so it is already settled here — no rAF race against the old code's
  // fixed two-frame wait.
  useLayoutEffect(() => {
    if (!enabled) return;
    const prev = stateRef.current;
    const depsKey = JSON.stringify(deps);
    if (!prev.inited) {
      stateRef.current = { inited: true, deps: depsKey };
      align(true);
      return;
    }
    if (prev.deps === depsKey) {
      // The effect re-ran without a real switch (e.g. a handler captured an
      // anchor but its setState was a no-op). Drop the stale capture so it is
      // never consumed by the *next* genuine switch and mis-pins it.
      pendingAnchorRef.current = null;
      return;
    }
    stateRef.current = { inited: true, deps: depsKey };
    align(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, align, ...deps]);

  return { captureAnchor };
}
