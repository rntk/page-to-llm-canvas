/** Geometry for the topic margin notes InPageRail.jsx draws beside the article text. */

// Notes sit just past the article's right edge: a curly brace spans the topic's
// sentences, with the topic written at its tip. Horizontal metrics, in px.
const BRACE_GAP = 6; // text edge → brace
export const BRACE_WIDTH = 14;
const NOTE_GAP = 4; // brace tip → note
const NOTE_MIN_WIDTH = 144;
const NOTE_MAX_WIDTH = 288;
const VIEWPORT_MARGIN = 12;
// Vertical gap between notes pushed apart by layoutNotes.
const NOTE_STACK_GAP = 4;

/**
 * Path for a right-pointing curly brace filling a width × height box.
 * @param {number} width Brace width in px.
 * @param {number} height Brace height in px.
 * @returns {string} SVG path data.
 */
export function curlyBracePath(width, height) {
  const inset = 1; // keep the stroke inside the box
  const spine = width / 2;
  const tip = width - inset;
  const top = inset;
  const bottom = Math.max(height - inset, top);
  const middle = (top + bottom) / 2;
  // Curl radius capped at a quarter of the height so spine segments never cross.
  const r = Math.max(0, Math.min(8, (bottom - top) / 4));
  return [
    `M${inset} ${top}`,
    `Q${spine} ${top} ${spine} ${top + r}`,
    `L${spine} ${middle - r}`,
    `Q${spine} ${middle} ${tip} ${middle}`,
    `Q${spine} ${middle} ${spine} ${middle + r}`,
    `L${spine} ${bottom - r}`,
    `Q${spine} ${bottom} ${inset} ${bottom}`,
  ].join(' ');
}

export function getViewportWidth(scrollWindow) {
  return scrollWindow.document?.documentElement?.clientWidth || scrollWindow.innerWidth || 0;
}

/**
 * Horizontal placement of the note column: braces start just past the rightmost
 * text edge; notes take the remaining viewport width, clamped to
 * [NOTE_MIN_WIDTH, NOTE_MAX_WIDTH].
 * @param {Array<{box: {right?: number}}>} cards Positioned cards.
 * @param {number} viewportWidth Viewport width in px.
 * @returns {{left: number, noteWidth: number}} Column left edge and note width.
 */
export function computeNoteColumn(cards, viewportWidth) {
  const textRight = Math.max(
    -Infinity,
    ...cards.map((card) => card.box.right).filter(Number.isFinite),
  );
  const reserved = BRACE_WIDTH + NOTE_GAP + NOTE_MAX_WIDTH + VIEWPORT_MARGIN;
  // Unmeasured text edge: fall back to the viewport's right margin.
  const left = Number.isFinite(textRight)
    ? textRight + BRACE_GAP
    : Math.max(0, viewportWidth - reserved);
  const available = viewportWidth - left - BRACE_WIDTH - NOTE_GAP - VIEWPORT_MARGIN;
  const noteWidth = Math.max(NOTE_MIN_WIDTH, Math.min(NOTE_MAX_WIDTH, available));
  return { left, noteWidth };
}

/**
 * Centre each note on its brace tip, pushing overlapping notes down just clear
 * of the one above. Written to the card elements as custom properties read by
 * the note's CSS: resting offset and the range the emulated stickiness may use.
 * @param {HTMLElement} track Element whose children are the card buttons, in card order.
 * @param {Array<{box: {top: number, height: number}}>} cards Cards sorted by box top.
 */
export function layoutNotes(track, cards) {
  let previousBottom = -Infinity;
  cards.forEach((card, index) => {
    const element = track.children[index];
    const label = element?.querySelector('.pagetollm-note-label');
    if (!label) return;
    const height = label.offsetHeight;
    const tip = card.box.top + card.box.height / 2;
    const top = Math.max(tip - height / 2, previousBottom + NOTE_STACK_GAP);
    previousBottom = top + height;
    const offset = top - card.box.top;
    element.style.setProperty('--pagetollm-note-y', `${offset}px`);
    element.style.setProperty('--pagetollm-note-h', `${height}px`);
    element.style.setProperty('--pagetollm-note-y-min', `${Math.min(offset, 0)}px`);
    element.style.setProperty(
      '--pagetollm-note-y-max',
      `${Math.max(offset, card.box.height - height)}px`,
    );
  });
}
