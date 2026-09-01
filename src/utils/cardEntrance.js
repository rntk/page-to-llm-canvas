// Entrance stagger shared by the topic rail and the summary column.
//
// The per-card delay is scaled so the whole column is in within
// STAGGER_WINDOW_MS however many cards there are. A fixed per-card delay would
// dribble 200 cards in over several seconds, which is exactly the "everything is
// slow" impression the staged reveal exists to remove.
export const STAGGER_WINDOW_MS = 240;
export const MAX_STAGGER_STEP_MS = 14;

// Duration of the card appear animations in modal.css. Kept here so the code
// that has to wait for them out-lives a tweak to one of the two call sites.
const CARD_APPEAR_MS = 300;
// When the last staggered card has finished moving, plus a frame of slack.
export const ENTRANCE_SETTLE_MS = STAGGER_WINDOW_MS + CARD_APPEAR_MS + 32;

/**
 * Per-card entrance delay, spread across a fixed window.
 *
 * @param {number} index Card position in the column.
 * @param {number} count Total cards being revealed.
 * @returns {number} Delay in ms.
 */
export function getCardEnterDelay(index, count) {
  if (count <= 1 || index <= 0) return 0;
  const step = Math.min(MAX_STAGGER_STEP_MS, STAGGER_WINDOW_MS / (count - 1));
  return Math.round(index * step);
}
