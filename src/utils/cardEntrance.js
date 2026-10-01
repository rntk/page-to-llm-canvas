// Fit the full topic rail or summary column entrance within STAGGER_WINDOW_MS.
export const STAGGER_WINDOW_MS = 240;
export const MAX_STAGGER_STEP_MS = 14;

// Match card entrance duration in modal.css.
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
