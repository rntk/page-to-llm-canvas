/**
 * Shared geometry for a topic card's title block: padding, up to N title lines,
 * a gap, then one meta line. Used by canvas cards (domain/topicCards.js) and the
 * dense rail (utils/denseCardLayout.js), so neither layout owns these numbers.
 *
 * Duplicated on purpose:
 * - `getTitleLineBudget` and the title font-size derivations. Canvas sizes titles
 *   from zoom; the rail caps a precomputed size. Unifying them would change visuals
 *   (see `getAdjustedTitleFontSize` in denseCardLayout.js).
 * - The min-height clamps (`CARD_MIN_CLAMPED_HEIGHT`, `DENSE_CARD_MIN_HEIGHT`). Both
 *   are 56 by coincidence.
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
