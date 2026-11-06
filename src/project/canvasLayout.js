import { clampScale, MIN_SCALE, MAX_SCALE } from '../utils/canvasMath.js';
export { wheelZoomFactor } from '../utils/canvasMath.js';

// Pure geometry helpers for the project canvas: grid auto-layout and zoom math.

export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 220;
export const CARD_GAP = 32;
export const MIN_ZOOM = MIN_SCALE;
export const MAX_ZOOM = MAX_SCALE;
export const ZOOM_STEP = 1.2;

/** Initial pan offset and zoom; also what "reset view" returns to. */
export const DEFAULT_VIEWPORT = Object.freeze({ x: 40, y: 40, zoom: 1 });

/**
 * Number of grid columns for `count` cards (roughly square).
 * @param {number} count
 */
export function gridColumns(count) {
  return count > 0 ? Math.ceil(Math.sqrt(count)) : 0;
}

/**
 * Row-major grid positions for the given ids, in order.
 * @param {Array<string|number>} ids
 * @returns {Record<string, {x: number, y: number}>} Keyed by id.
 */
export function layoutGrid(ids) {
  const columns = gridColumns(ids.length);
  const positions = {};
  ids.forEach((id, index) => {
    positions[id] = {
      x: (index % columns) * (CARD_WIDTH + CARD_GAP),
      y: Math.floor(index / columns) * (CARD_HEIGHT + CARD_GAP),
    };
  });
  return positions;
}

/**
 * Clamps a zoom factor to [MIN_ZOOM, MAX_ZOOM]; non-finite input becomes 1.
 * @param {number} zoom
 */
export function clampZoom(zoom) {
  return clampScale(zoom);
}

/**
 * Multiplies the zoom by `factor` while keeping the surface point under
 * (`originX`, `originY`) (viewport-relative px) fixed on screen.
 * @param {{x: number, y: number, zoom: number}} viewport
 * @param {number} factor
 * @param {number} [originX]
 * @param {number} [originY]
 */
export function zoomViewport(viewport, factor, originX = 0, originY = 0) {
  const zoom = clampZoom(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const ratio = zoom / viewport.zoom;
  return {
    x: originX - (originX - viewport.x) * ratio,
    y: originY - (originY - viewport.y) * ratio,
    zoom,
  };
}
