// Keep enough range for a high-level canvas view while retaining a usable
// minimum size for the canvas content.
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;

/**
 * Clamp a canvas scale to the supported zoom range.
 *
 * @param {number} value
 * @returns {number}
 */
export function clampScale(value) {
  const safe = Number.isFinite(value) ? value : 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, safe));
}

/**
 * Keep the canvas point under the cursor fixed while changing scale.
 *
 * @param {object} params
 * @param {{x: number, y: number}} params.cursor
 * @param {{x: number, y: number}} params.translate
 * @param {number} params.currentScale
 * @param {number} params.nextScale
 * @returns {{x: number, y: number}}
 */
export function cursorAnchoredTranslate({ cursor, translate, currentScale, nextScale }) {
  const cx = (cursor.x - translate.x) / currentScale;
  const cy = (cursor.y - translate.y) / currentScale;
  return {
    x: cursor.x - cx * nextScale,
    y: cursor.y - cy * nextScale,
  };
}

/** Screen-space pan [dx, dy] per arrow key press. */
export const ARROW_PAN = Object.freeze({
  ArrowUp: [0, 80],
  ArrowDown: [0, -80],
  ArrowLeft: [80, 0],
  ArrowRight: [-80, 0],
});

/** PageUp/PageDown pan distance for a viewport of the given height.
 * @param {number} viewportHeight
 * @returns {number}
 */
export function pagePanStep(viewportHeight) {
  return Math.max(120, viewportHeight * 0.8);
}

/** Convert wheel deltas to the shared canvas zoom curve.
 * @param {number} deltaY
 * @param {number} [deltaMode]
 * @param {number} [viewportHeight]
 * @returns {number}
 */
export function wheelZoomFactor(deltaY, deltaMode = 0, viewportHeight = 1) {
  const pixels =
    deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportHeight) : 1);
  return Math.exp(-Math.max(-240, Math.min(240, pixels)) * 0.0008);
}

/** Horizontal pan, in pixels, for a wheel event that is mostly sideways
 * (a touchpad swipe or shift+wheel). Returns 0 for vertical-dominant wheels,
 * which zoom, and for Ctrl/⌘ wheels (pinch zoom). A positive result moves
 * content right, so scrolling right brings content from the right into view.
 * @param {{deltaX: number, deltaY: number, deltaMode?: number, ctrlKey?: boolean, metaKey?: boolean}} event
 * @param {number} [viewportWidth]
 * @returns {number}
 */
export function horizontalWheelPan(event, viewportWidth = 1) {
  if (event.ctrlKey || event.metaKey) return 0;
  const { deltaX, deltaY, deltaMode = 0 } = event;
  if (!deltaX || Math.abs(deltaX) <= Math.abs(deltaY)) return 0;
  const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? Math.max(1, viewportWidth) : 1;
  return -deltaX * unit;
}
