import { useEffect, useReducer, useState } from 'react';

// Hard cap on how long the opening overlay may hold the canvas back. Every gate
// below it is best-effort: a record with no measurable layout, a stalled image,
// a hidden tab that never paints — none of them may strand the user behind a
// progress bar, so the reveal always happens by this deadline.
export const REVEAL_TIMEOUT_MS = 900;
// Overlay fade-out. Runs concurrently with the content's entrance so the two
// crossfade rather than blinking through an empty canvas.
export const OVERLAY_FADE_MS = 260;
// How long the entrance classes stay on. Must outlast the longest staggered
// card animation in modal.css.
export const ENTRANCE_MS = 620;

const STEPS = {
  layout: { progress: 0.28, label: 'Rendering article' },
  measure: { progress: 0.68, label: 'Measuring topic layout' },
  arrange: { progress: 0.92, label: 'Arranging topic cards' },
  ready: { progress: 1, label: 'Ready' },
};

/**
 * Opening-sequence phase machine.
 *
 * A reducer rather than plain setters so the effects below advance it through a
 * stable `dispatch` instead of a synchronous setState in an effect body (the
 * same reasoning as useInitialView). Each transition is guarded, so a re-run of
 * an effect can neither skip nor rewind a step.
 *
 * @param {{stage: string, isOverlayLeaving: boolean}} state
 * @param {string} action
 * @returns {{stage: string, isOverlayLeaving: boolean}}
 */
export function canvasStartupReducer(state, action) {
  switch (action) {
    // Gates settled (or the deadline expired): uncover the canvas and start the
    // entrance, with the overlay fading out over the top of it.
    case 'reveal':
      return state.stage === 'preparing' ? { stage: 'entering', isOverlayLeaving: true } : state;
    case 'overlay-faded':
      return state.isOverlayLeaving ? { ...state, isOverlayLeaving: false } : state;
    case 'entrance-done':
      return state.stage === 'entering' ? { stage: 'ready', isOverlayLeaving: false } : state;
    default:
      return state;
  }
}

/**
 * Pick the step to display from the gates that are still outstanding.
 *
 * @param {{isReady: boolean, layoutSettled: boolean, viewSettled: boolean}} state
 * @returns {{progress: number, label: string}}
 */
export function resolveStartupStep({ isReady, layoutSettled, viewSettled }) {
  if (isReady) return STEPS.ready;
  if (!layoutSettled) return STEPS.layout;
  if (!viewSettled) return STEPS.measure;
  return STEPS.arrange;
}

/**
 * Owns the canvas opening sequence: hold an opaque overlay over the canvas while
 * the article is measured and the opening view stages itself, then reveal the
 * finished layout in one animated step.
 *
 * The work being hidden is the jumpy part — sentence measurement republishing
 * rail geometry, the opening view switching to the leaf level, zooming out, then
 * panning to the first topic. All of it happens at full opacity behind the
 * overlay (never `display: none` or `opacity: 0` on the content itself, both of
 * which zero out `getClientRects()` and would starve the very measurement being
 * waited on).
 *
 * Every gate is individually skippable and the whole thing races a deadline, so
 * the overlay cannot outlive the work it covers.
 *
 * @param {object} params
 * @param {boolean} params.hasContent Whether there is anything to lay out at
 *   all; an empty record reveals immediately, with no overlay or entrance.
 * @param {boolean} params.layoutSettled Measurement has converged.
 * @param {boolean} params.viewSettled The opening-view machine has finished.
 * @param {number} [params.revealTimeoutMs] Override for the reveal deadline.
 * @returns {{isReady: boolean, isEntering: boolean, showOverlay: boolean, isOverlayLeaving: boolean, progress: number, statusLabel: string}}
 */
export function useCanvasStartup({
  hasContent,
  layoutSettled,
  viewSettled,
  revealTimeoutMs = REVEAL_TIMEOUT_MS,
}) {
  // An empty canvas has nothing to stage: start revealed, so it never flashes an
  // overlay (or an entrance animation) it did not need.
  const [state, dispatch] = useReducer(canvasStartupReducer, hasContent, (content) => ({
    stage: content ? 'preparing' : 'ready',
    isOverlayLeaving: false,
  }));
  // Absolute, so a gate settling mid-flight cannot restart the countdown.
  const [deadline] = useState(() => Date.now() + revealTimeoutMs);
  const { stage, isOverlayLeaving } = state;

  useEffect(() => {
    if (stage !== 'preparing') return undefined;
    if (!hasContent || (layoutSettled && viewSettled)) {
      dispatch('reveal');
      return undefined;
    }
    const timer = setTimeout(() => dispatch('reveal'), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [stage, hasContent, layoutSettled, viewSettled, deadline]);

  useEffect(() => {
    if (stage !== 'entering') return undefined;
    const fadeTimer = setTimeout(() => dispatch('overlay-faded'), OVERLAY_FADE_MS);
    const entranceTimer = setTimeout(() => dispatch('entrance-done'), ENTRANCE_MS);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(entranceTimer);
    };
  }, [stage]);

  const isReady = stage !== 'preparing';
  const { progress, label } = resolveStartupStep({ isReady, layoutSettled, viewSettled });

  return {
    isReady,
    isEntering: stage === 'entering',
    // Kept mounted through the fade so the overlay and the canvas underneath
    // crossfade, instead of the overlay vanishing on the first revealed frame.
    showOverlay: stage === 'preparing' || isOverlayLeaving,
    isOverlayLeaving,
    progress,
    statusLabel: label,
  };
}
