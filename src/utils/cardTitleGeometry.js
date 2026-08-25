/**
 * Shared geometry for a topic card's title block.
 *
 * Both card layouts — the canvas cards in `domain/topicCards.js` and the dense
 * hierarchy rail in `utils/denseCardLayout.js` — render the same title block:
 * padding, a title of up to N lines, a gap, then a single meta line. These
 * constants describe that block, and live here rather than in either layout so
 * neither one owns the other's numbers.
 *
 * Deliberately NOT shared, and left duplicated on purpose:
 *
 * - The two `getTitleLineBudget` copies and the two title font-size
 *   derivations. Canvas sizes its title from the zoom scale, while the rail
 *   caps an already-computed per-card size; see the note on
 *   `getAdjustedTitleFontSize` in denseCardLayout.js for why unifying those
 *   two would change visual output.
 * - The min-height clamps. `CARD_MIN_CLAMPED_HEIGHT` (canvas stacking) and
 *   `DENSE_CARD_MIN_HEIGHT` (rail) are both 56 by coincidence, not because
 *   one constrains the other.
 */

/** Multiplier from title font size to rendered line height. */
export const CARD_TITLE_LINE_HEIGHT = 1.2;
/** Title lines a normal-height card may use. */
export const CARD_TITLE_MAX_LINES = 2;
/** Title lines a card shorter than the compact threshold may use. */
export const CARD_COMPACT_TITLE_MAX_LINES = 1;
/** Card height (px) below which the compact title budget applies. */
export const CARD_COMPACT_HEIGHT_THRESHOLD = 88;
/** Combined top + bottom padding (px) inside a card. */
export const CARD_VERTICAL_PADDING_PX = 16;
/** Height (px) of the single meta line under the title. */
export const CARD_META_LINE_HEIGHT_PX = 12;
/** Gap (px) between the title block and the meta line. */
export const CARD_CONTENT_GAP_PX = 3;

/**
 * Topic title font size at zoom 1, before either layout's own adjustment.
 * Canvas grows it with zoom-out; the rail uses it as the reference size that
 * summary-panel fonts scale against.
 */
export const CARD_BASE_TITLE_FONT_SIZE = 12;
