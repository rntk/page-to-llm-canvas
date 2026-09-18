import {
  CARD_BASE_TITLE_FONT_SIZE,
  CARD_COMPACT_HEIGHT_THRESHOLD,
  CARD_COMPACT_TITLE_MAX_LINES,
  CARD_CONTENT_GAP_PX,
  CARD_META_LINE_HEIGHT_PX,
  CARD_TITLE_LINE_HEIGHT,
  CARD_TITLE_MAX_LINES,
  CARD_VERTICAL_PADDING_PX,
} from './cardTitleGeometry.js';
import { clampCardsToParents } from './cardContainment.js';

/**
 * Pure collision-resolution and layout helpers for the dense card rail view.
 *
 * These functions are stateless and have no DOM/React dependencies, making
 * them directly unit-testable without mounting a component.
 */

export const DENSE_CARD_GAP = 4;
export const DENSE_CARD_MIN_HEIGHT = 56;
const DENSE_CARD_MAX_COMPACT_HEIGHT = 96;
const DENSE_CARD_HEIGHT_REDUCTION = 16;
const DENSE_CARD_MAX_NUDGE = 18;
export const BASE_TOPIC_TITLE_FONT_SIZE = CARD_BASE_TITLE_FONT_SIZE;
const SUMMARY_KICKER_FONT_SIZE = 11;
const SUMMARY_TITLE_FONT_SIZE = 17.6;
const SUMMARY_TEXT_FONT_SIZE = 15.4;
const SUMMARY_YOUTUBE_FONT_SIZE = 12.1;

/**
 * Returns `value` if it is a finite number, otherwise `fallback`.
 *
 * @param {*} value
 * @param {number} fallback
 * @returns {number}
 */
function getFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Returns true when two cards' bounding boxes (plus the gap) overlap vertically.
 *
 * @param {{top: number, height: number}} topCard
 * @param {{top: number, height: number}} bottomCard
 * @returns {boolean}
 */
export function cardsOverlapVertically(topCard, bottomCard) {
  return (
    topCard.top + topCard.height + DENSE_CARD_GAP > bottomCard.top &&
    bottomCard.top + bottomCard.height + DENSE_CARD_GAP > topCard.top
  );
}

/**
 * Returns the compacted height for a card when it is crowded.
 * Non-crowded cards and already-short cards keep their original height.
 *
 * @param {{height: number}} card
 * @param {boolean} isCrowded
 * @returns {number}
 */
export function getCompactCardHeight(card, isCrowded) {
  const height = getFiniteNumber(card.height, DENSE_CARD_MIN_HEIGHT);
  if (!isCrowded || height > DENSE_CARD_MAX_COMPACT_HEIGHT) return height;
  return Math.max(DENSE_CARD_MIN_HEIGHT, height - DENSE_CARD_HEIGHT_REDUCTION);
}

/**
 * Returns the number of title lines allowed for a card of the given height.
 *
 * @param {number} height
 * @returns {number}
 */
export function getTitleLineBudget(height) {
  return height < CARD_COMPACT_HEIGHT_THRESHOLD
    ? CARD_COMPACT_TITLE_MAX_LINES
    : CARD_TITLE_MAX_LINES;
}

/**
 * Clamps the card's title font size so it fits within the available card
 * height after accounting for padding, meta line, and title line-height.
 *
 * NOTE: This intentionally differs from `getTopicTitleFontSize` in
 * topicCards.js. That function derives its base size from a canvas zoom
 * scale (1/clampScale). This function receives an already-computed
 * `titleFontSize` on the card and simply caps it to what the card height
 * can physically contain. Unifying the two would change visual output.
 *
 * @param {{titleFontSize: number}} card
 * @param {number} height
 * @returns {number}
 */
export function getAdjustedTitleFontSize(card, height) {
  const fontSize = getFiniteNumber(card.titleFontSize, 12);
  const titleLines = getTitleLineBudget(height);
  const availableTitleHeight = Math.max(
    1,
    height - CARD_VERTICAL_PADDING_PX - CARD_META_LINE_HEIGHT_PX - CARD_CONTENT_GAP_PX,
  );
  const heightCapped = availableTitleHeight / (CARD_TITLE_LINE_HEIGHT * titleLines);
  return Math.max(1, Math.min(fontSize, heightCapped));
}

/**
 * Computes the rendered label height (title block + meta line) for a card.
 *
 * @param {{titleFontSize: number, height: number}} card
 * @returns {number}
 */
export function getCardLabelHeight(card) {
  const titleLines = getTitleLineBudget(card.height);
  const titleHeight = card.titleFontSize * CARD_TITLE_LINE_HEIGHT * titleLines;
  return Math.ceil(titleHeight + CARD_CONTENT_GAP_PX + CARD_META_LINE_HEIGHT_PX);
}

/**
 * Mutates topCard.top and bottomCard.top to eliminate overlap between an
 * adjacent pair, spreading the correction evenly while respecting per-card
 * nudge limits anchored to each card's originalTop.
 *
 * @param {{top: number, height: number, originalTop: number}} topCard
 * @param {{top: number, height: number, originalTop: number}} bottomCard
 * @returns {void}
 */
export function nudgeCrowdedPair(topCard, bottomCard) {
  const overlap = topCard.top + topCard.height + DENSE_CARD_GAP - bottomCard.top;
  if (overlap <= 0) return;

  let remaining = overlap;
  const topMin = Math.max(0, topCard.originalTop - DENSE_CARD_MAX_NUDGE);
  const bottomMax = bottomCard.originalTop + DENSE_CARD_MAX_NUDGE;

  const topMove = Math.min(remaining / 2, Math.max(0, topCard.top - topMin));
  topCard.top -= topMove;
  remaining -= topMove;

  const bottomMove = Math.min(remaining, Math.max(0, bottomMax - bottomCard.top));
  bottomCard.top += bottomMove;
}

/**
 * Returns the z-index for a card. Crowded cards with fewer sentences float
 * higher so labels remain visible.
 *
 * @param {object} card
 * @param {number} [card.sentenceCount]
 * @param {boolean} isCrowded
 * @returns {number}
 */
export function getDenseCardZIndex(card, isCrowded) {
  if (!isCrowded) return 1;
  return 20 + Math.max(0, 10 - Math.min(card.sentenceCount || 0, 10));
}

/**
 * Runs multi-pass overlap resolution on a single level's cards, compacting
 * heights and nudging positions to reduce visual crowding.
 *
 * @param {Array<{top: number, height: number, fullPath: string, titleFontSize: number, sentenceCount: number}>} levelCards
 * @returns {Array}
 */
export function adjustCrowdedLevelCards(levelCards) {
  const sortedCards = [...levelCards].sort(
    (left, right) => left.top - right.top || left.fullPath.localeCompare(right.fullPath),
  );

  const workingCards = sortedCards.map((card, index) => {
    const previousCard = sortedCards[index - 1];
    const nextCard = sortedCards[index + 1];
    const isCrowded =
      (previousCard && cardsOverlapVertically(previousCard, card)) ||
      (nextCard && cardsOverlapVertically(card, nextCard));
    const height = getCompactCardHeight(card, isCrowded);

    return {
      ...card,
      sourceCard: card,
      top: getFiniteNumber(card.top, 0),
      height,
      originalTop: getFiniteNumber(card.top, 0),
      isCrowded,
    };
  });

  for (let pass = 0; pass < 3; pass += 1) {
    for (let index = 1; index < workingCards.length; index += 1) {
      nudgeCrowdedPair(workingCards[index - 1], workingCards[index]);
    }
    for (let index = workingCards.length - 2; index >= 0; index -= 1) {
      nudgeCrowdedPair(workingCards[index], workingCards[index + 1]);
    }
  }

  return workingCards.map(({ isCrowded, ...card }) => ({
    ...card,
    top: Math.round(card.top),
    height: Math.round(card.height),
    titleFontSize: getAdjustedTitleFontSize(card, card.height),
    zIndex: getDenseCardZIndex(card, isCrowded),
  }));
}

/**
 * Groups cards by levelIndex and runs crowded-card adjustment per column,
 * returning the full adjusted set sorted by level then vertical position.
 *
 * Compaction and nudging are per column, so a crowded parent can end up
 * shorter than an uncrowded child. Children are clamped back inside their
 * parents afterwards (matched by parent path and `startSentence`, see
 * `clampCardsToParents`), and a clamped card's title size is re-capped to its
 * new height.
 *
 * @param {Array<{levelIndex: number, top: number, fullPath: string, startSentence?: number}>} cards
 * @returns {Array}
 */
export function getAdjustedHierarchyCards(cards) {
  const cardsByLevel = new Map();
  cards.forEach((card) => {
    const levelCards = cardsByLevel.get(card.levelIndex) || [];
    levelCards.push(card);
    cardsByLevel.set(card.levelIndex, levelCards);
  });

  const adjustedCards = Array.from(cardsByLevel.values()).flatMap(adjustCrowdedLevelCards);
  return clampCardsToParents(adjustedCards, DENSE_CARD_MIN_HEIGHT)
    .map((card, index) =>
      card === adjustedCards[index]
        ? card
        : {
            ...card,
            top: Math.round(card.top),
            height: Math.round(card.height),
            titleFontSize: getAdjustedTitleFontSize(card.sourceCard || card, Math.round(card.height)),
          },
    )
    .sort(
      (left, right) =>
        left.levelIndex - right.levelIndex ||
        left.top - right.top ||
        left.fullPath.localeCompare(right.fullPath),
    );
}

/**
 * Scales the summary-panel font sizes proportionally to `titleFontSize`'s ratio
 * against the base topic title size.
 *
 * The floating current-topic summary and in-card controls pass their matched
 * rail card here so their typography follows the same zoom and dense-layout
 * cap as the topic title.
 *
 * @param {object} [anchorCard]
 * @param {number} [anchorCard.titleFontSize]
 * @returns {{kicker: number, title: number, text: number, youtube: number}}
 */
export function getSummaryFontSizes(anchorCard) {
  const anchorTitleSize = getFiniteNumber(anchorCard?.titleFontSize, BASE_TOPIC_TITLE_FONT_SIZE);
  const zoomMultiplier = Math.max(1, anchorTitleSize / BASE_TOPIC_TITLE_FONT_SIZE);

  return {
    kicker: SUMMARY_KICKER_FONT_SIZE * zoomMultiplier,
    title: SUMMARY_TITLE_FONT_SIZE * zoomMultiplier,
    text: SUMMARY_TEXT_FONT_SIZE * zoomMultiplier,
    youtube: SUMMARY_YOUTUBE_FONT_SIZE * zoomMultiplier,
  };
}

/**
 * Trim applied to the floating current-topic summary only. At full parity with
 * the topic-title zoom multiplier the panel crowds the view: it has to share
 * the screen with the reading column and the rail. Tuned by eye to 0.85 of the
 * raw zoom size. SUMMARY_CARD_WIDTH is tuned alongside it — the two are stepped
 * together so the panel grows and shrinks as a unit, but they are independent
 * knobs (width sets the footprint, this sets legibility) and are NOT currently
 * at the same fraction of parity. In-card typography (the topic title, the
 * per-card YouTube link) keeps the untrimmed size.
 */
export const FLOATING_SUMMARY_FONT_RATIO = 0.85;

/**
 * Font sizes for the floating current-topic summary card.
 *
 * Takes the zoom-only title size (getZoomAdjustedTitleFontSize) rather than an
 * anchor card: the panel floats outside the rail and sizes itself against the
 * canvas transform, not against the height budget of whichever topic card it is
 * anchored to. Both the settled React render and App's live per-frame zoom path
 * call this, so they cannot drift apart.
 *
 * @param {number} zoomTitleFontSize
 * @returns {{kicker: number, title: number, text: number, youtube: number}}
 */
export function getFloatingSummaryFontSizes(zoomTitleFontSize) {
  const sizes = getSummaryFontSizes({ titleFontSize: zoomTitleFontSize });
  return {
    kicker: sizes.kicker * FLOATING_SUMMARY_FONT_RATIO,
    title: sizes.title * FLOATING_SUMMARY_FONT_RATIO,
    text: sizes.text * FLOATING_SUMMARY_FONT_RATIO,
    youtube: sizes.youtube * FLOATING_SUMMARY_FONT_RATIO,
  };
}
