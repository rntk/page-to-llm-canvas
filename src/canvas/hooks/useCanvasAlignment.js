import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

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
 * Decide where the reading column's left edge should sit in wrap-local px.
 *
 * Keeps the column in a dead-zone around the viewport center, moving by the
 * minimum delta to re-enter the zone and keeping both edges within `EDGE_MARGIN`.
 * A column already near center is untouched. Runs only on deliberate switches,
 * so it does not fight manual panning.
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
 * Unified canvas alignment to prevent layout-affecting changes from jumping.
 *
 * It uses the reading column (`anchorRef`) as the single anchor. Changes like toggles,
 * levels, or rails switch layout around it:
 *  - Continuity: captures the column's on-screen position before the change via
 *    `captureAnchor()`, then pans instantly so it lands in the same place (FLIP).
 *  - Comfort: if the column drifts out of the dead-zone, nudges it back smoothly
 *    by the minimum amount one frame later (using `flashFocus` for transition).
 *
 * Runs only on deliberate changes (from `deps`) or the initial load (which centering
 * pins to the top margin), never during manual panning/zooming.
 *
 * @param {{
 *   enabled: boolean,
 *   anchorRef: import('react').RefObject<HTMLElement>,
 *   viewport: {
 *     canvasWrapElRef: import('react').RefObject<HTMLElement>,
 *     scaleRef: import('react').RefObject<number>,
 *     translateRef: import('react').RefObject<{x: number, y: number}>,
 *     setTransformNow: (scale: number, translate: {x: number, y: number}) => void,
 *   },
 *   flashFocus?: () => void,
 *   deps: ReadonlyArray<unknown>,
 * }} params
 * @returns {{
 *   captureAnchor: (resetTop?: boolean) => void,
 *   skipNextAlignment: () => void,
 * }}
 */
export function useCanvasAlignment({ enabled, anchorRef, viewport, flashFocus, deps }) {
  // The wrap element is the measurement frame here, not "the canvas viewport"
  // in the CSS sense, so keep this hook's own `wrapElRef` naming for the body.
  const { canvasWrapElRef: wrapElRef, setTransformNow, translateRef, scaleRef } = viewport;
  // The column's pre-change screen position, recorded synchronously by callers
  // before they trigger a layout-affecting state update. `resetTop` requests
  // that vertical position be reset to the top margin instead of preserved
  // (used when the content swaps wholesale, i.e. summary-mode toggle).
  const pendingAnchorRef = useRef(null);
  // Tracks the deps we last aligned for, so we run continuity only on a real
  // change and the initial center exactly once.
  const stateRef = useRef({ inited: false, deps: null });
  // Pending rAF for the deferred (animated) comfort/reset move.
  const moveRafRef = useRef(0);
  // When set, the next deps change is positioned by someone else (e.g. a
  // pending zoom-to-sentence) — skip alignment so the two don't fight.
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

      // Initial center: no prior position to preserve — center and pin the top
      // margin in one instant move (no animation, so opening doesn't lurch).
      if (isInitial) {
        panTo(computeComfortLeft(anchorLeft, columnWidth, wrapRect.width), TOP_MARGIN);
        return;
      }

      const captured = pendingAnchorRef.current;
      pendingAnchorRef.current = null;

      // Baseline = the column's pre-switch on-screen position (continuity). For a
      // content swap (`resetTop`) the vertical baseline stays where it is and the
      // top reset becomes part of the animated move below.
      const baseLeft = captured ? captured.left : anchorLeft;
      const baseTop = captured && !captured.resetTop ? captured.top : anchorTop;

      // Final = baseline gently re-centered (x), top margin restored on a swap.
      const finalLeft = computeComfortLeft(baseLeft, columnWidth, wrapRect.width);
      const finalTop = captured && captured.resetTop ? TOP_MARGIN : baseTop;

      // Step 1 — instant continuity: cancel the reflow so the switch shows no
      // jump. Applied synchronously, pre-paint, with no transition.
      panTo(baseLeft, baseTop);

      // Step 2 — animated move: the intentional re-center / top reset, deferred a
      // frame so the continuity transform paints first and the slide starts from
      // the jump-free position.
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
    if (skipNextRef.current) {
      // This switch is positioned by another controller (zoom-to-sentence).
      // Record the deps (so the *next* real switch still aligns) and bail,
      // dropping any stale capture / pending animated move.
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
  }, [enabled, align, ...deps]);

  // Cancel any in-flight animated move on unmount.
  useEffect(
    () => () => {
      if (moveRafRef.current) cancelAnimationFrame(moveRafRef.current);
    },
    [],
  );

  return { captureAnchor, skipNextAlignment };
}
