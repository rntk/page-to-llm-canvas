// Keep enough range for a high-level canvas view while retaining a usable
// minimum size for the canvas content.
const MIN_SCALE = 0.1;
const MAX_SCALE = 3;

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
