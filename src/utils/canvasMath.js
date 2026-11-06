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
