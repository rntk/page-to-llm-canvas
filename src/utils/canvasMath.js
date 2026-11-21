// Wide enough for a high-level view, with a usable minimum for the content.
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 3;

// Match the edge margin in useCanvasAlignment.
const EDGE_MARGIN = 24;
const FALLBACK_CONTENT_LEFT = 40;

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

/**
 * Calculate the horizontal translation for a target zoom. Center the full group
 * if it fits, then try the reading column, and otherwise pin the column's left edge.
 * @param {object} params
 * @param {number} params.localContentLeft Reading column's unscaled left offset.
 * @param {number} params.columnLayoutWidth Unscaled reading column width.
 * @param {number} params.groupLayoutWidth Unscaled group width.
 * @param {number} params.nextScale Target zoom scale.
 * @param {number} params.wrapWidth Visible canvas width.
 * @returns {number} Horizontal translation in pixels.
 */
export function computeZoomPinnedX({
  localContentLeft,
  columnLayoutWidth,
  groupLayoutWidth,
  nextScale,
  wrapWidth,
}) {
  const scaledLeft = localContentLeft * nextScale;
  if (!(wrapWidth > 0)) return FALLBACK_CONTENT_LEFT - scaledLeft;
  const usableWidth = wrapWidth - 2 * EDGE_MARGIN;

  const groupWidth = groupLayoutWidth * nextScale;
  if (groupWidth > 0 && groupWidth <= usableWidth) return (wrapWidth - groupWidth) / 2;

  const columnWidth = columnLayoutWidth * nextScale;
  if (!(columnWidth > 0)) return FALLBACK_CONTENT_LEFT - scaledLeft;
  const targetLeft = columnWidth >= usableWidth ? EDGE_MARGIN : (wrapWidth - columnWidth) / 2;
  return targetLeft - scaledLeft;
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

/** Horizontal pan in px for a mostly-sideways wheel event (touchpad swipe or
 * shift+wheel). Returns 0 for vertical wheels (these zoom) and Ctrl/⌘ wheels
 * (pinch zoom). Positive results move content right.
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
