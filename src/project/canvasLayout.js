import { clampScale } from '../utils/canvasMath.js';
export { wheelZoomFactor } from '../utils/canvasMath.js';

// Pure geometry helpers for the project canvas: grid auto-layout and zoom math.

export const CARD_WIDTH = 320;
export const CARD_HEIGHT = 220;
export const CARD_GAP = 32;
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
 * Multiplies the zoom by `factor` while keeping the surface point under
 * (`originX`, `originY`) (viewport-relative px) fixed on screen.
 * @param {{x: number, y: number, zoom: number}} viewport
 * @param {number} factor
 * @param {number} [originX]
 * @param {number} [originY]
 */
export function zoomViewport(viewport, factor, originX = 0, originY = 0) {
  const zoom = clampScale(viewport.zoom * factor);
  if (zoom === viewport.zoom) return viewport;
  const ratio = zoom / viewport.zoom;
  return {
    x: originX - (originX - viewport.x) * ratio,
    y: originY - (originY - viewport.y) * ratio,
    zoom,
  };
}

// Excerpt cards stack under their page card, indented so the connector from
// the page can run down the gap on their left.
export const EXCERPT_INDENT = 28;
export const EXCERPT_WIDTH = CARD_WIDTH - EXCERPT_INDENT;
export const EXCERPT_HEIGHT = 168;
export const EXCERPT_GAP = 20;
// Connector anchor: how far in from the page card's left edge the spine runs.
const SPINE_INSET = EXCERPT_INDENT / 2;

/**
 * Grid slots for page cards with their excerpts stacked beneath them. Each row
 * is as tall as its tallest stack, so stacks never run into the next row.
 * Excerpts whose page is not on the canvas share one extra trailing slot.
 *
 * @param {Array<string|number>} pageIds Page card ids, in order.
 * @param {Record<string, string[]>} excerptsByPage Excerpt node ids per page id.
 * @param {string[]} [orphanIds] Excerpt node ids without a page card.
 * @returns {{pages: Record<string, {x: number, y: number}>, excerpts: Record<string, {page: (string|number|null), dx: number, dy: number, x: number, y: number}>}}
 *   Excerpts carry their offset from the page card (`dx`, `dy`) so they can
 *   follow a dragged page, plus their default absolute position.
 */
export function layoutProjectCanvas(pageIds, excerptsByPage, orphanIds = []) {
  const slots = [
    ...pageIds.map((id) => ({ page: id, excerpts: excerptsByPage[id] || [], hasCard: true })),
    ...(orphanIds.length ? [{ page: null, excerpts: orphanIds, hasCard: false }] : []),
  ];
  const columns = gridColumns(slots.length);
  const stackHeight = (slot) =>
    (slot.hasCard ? CARD_HEIGHT : -EXCERPT_GAP) +
    slot.excerpts.length * (EXCERPT_HEIGHT + EXCERPT_GAP);
  const rowTops = [];
  let top = 0;
  for (let start = 0; start < slots.length; start += columns) {
    rowTops.push(top);
    const row = slots.slice(start, start + columns);
    top += Math.max(CARD_HEIGHT, ...row.map(stackHeight)) + CARD_GAP;
  }

  const pages = {};
  const excerpts = {};
  slots.forEach((slot, index) => {
    const x = (index % columns) * (CARD_WIDTH + CARD_GAP);
    const y = rowTops[Math.floor(index / columns)];
    if (slot.hasCard) pages[slot.page] = { x, y };
    const first = slot.hasCard ? CARD_HEIGHT + EXCERPT_GAP : 0;
    slot.excerpts.forEach((id, order) => {
      const dx = slot.hasCard ? EXCERPT_INDENT : 0;
      const dy = first + order * (EXCERPT_HEIGHT + EXCERPT_GAP);
      excerpts[id] = { page: slot.page, dx, dy, x: x + dx, y: y + dy };
    });
  });
  return { pages, excerpts };
}

/**
 * SVG path linking a page card to one of its excerpt cards. An excerpt still
 * in its stack gets an elbow down the page's left gutter; one dragged
 * elsewhere gets a curve from the page's bottom edge to the excerpt's left edge.
 * @param {{x: number, y: number}} page Page card top-left.
 * @param {{x: number, y: number}} excerpt Excerpt card top-left.
 * @returns {string}
 */
export function excerptConnectorPath(page, excerpt) {
  const startX = page.x + SPINE_INSET;
  const startY = page.y + CARD_HEIGHT;
  const endX = excerpt.x;
  const endY = excerpt.y + EXCERPT_HEIGHT / 2;
  if (endX >= startX + 4 && endX <= page.x + CARD_WIDTH && endY > startY) {
    return `M ${startX} ${startY} V ${endY} H ${endX}`;
  }
  const bend = Math.max(40, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX} ${startY + bend}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}
