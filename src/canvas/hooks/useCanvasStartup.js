import { useEffect, useReducer, useState } from 'react';

// Reveal by this deadline even if layout, images, or tab painting stalls.
export const REVEAL_TIMEOUT_MS = 900;
// Overlay fade-out; runs concurrently with the content's entrance (crossfade).
export const OVERLAY_FADE_MS = 260;
// How long the entrance classes stay on; must outlast the longest card animation in modal.css.
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
 * Guarded transitions prevent repeated effects from skipping or rewinding a step.
 *
 * @param {{stage: string, isOverlayLeaving: boolean}} state
 * @param {string} action
 * @returns {{stage: string, isOverlayLeaving: boolean}}
 */
export function canvasStartupReducer(state, action) {
  switch (action) {
    // Gates settled or deadline hit: uncover the canvas; the overlay fades over the entrance.
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
 * Owns the canvas opening sequence: an opaque overlay covers the canvas while the
 * article is measured and the opening view stages itself, then the layout is
 * revealed in one animated step.
 *
 * The content stays at full opacity behind the overlay: `display: none` or
 * `opacity: 0` would zero `getClientRects()` and starve the measurement.
 *
 * The whole sequence races a deadline, so the overlay cannot outlive its work.
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
  // An empty canvas starts revealed: no overlay or entrance flash.
  const [state, dispatch] = useReducer(canvasStartupReducer, hasContent, (content) => ({
    stage: content ? 'preparing' : 'ready',
    isOverlayLeaving: false,
  }));
  // Absolute, so a gate settling mid-flight doesn't restart the countdown.
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
    // Stays mounted through the fade so it crossfades with the canvas.
    showOverlay: stage === 'preparing' || isOverlayLeaving,
    isOverlayLeaving,
    progress,
    statusLabel: label,
  };
}
