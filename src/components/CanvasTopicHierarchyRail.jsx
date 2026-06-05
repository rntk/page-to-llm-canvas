import React from 'react';
import { getHierarchyTopicAccentColor } from '../utils/topicColorUtils.js';
import { isTopicRead } from '../utils/topicReadUtils.js';

const DENSE_CARD_GAP = 4;
const DENSE_CARD_MIN_HEIGHT = 56;
const DENSE_CARD_MAX_COMPACT_HEIGHT = 96;
const DENSE_CARD_HEIGHT_REDUCTION = 16;
const DENSE_CARD_MAX_NUDGE = 18;
const CARD_TITLE_LINE_HEIGHT = 1.2;
const CARD_TITLE_MAX_LINES = 2;
const CARD_VERTICAL_CHROME_PX = 31;
const BASE_TOPIC_TITLE_FONT_SIZE = 12;
const SUMMARY_TITLE_FONT_SIZE = 16;
const SUMMARY_TEXT_FONT_SIZE = 14;

function getFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function cardsOverlapVertically(topCard, bottomCard) {
  return (
    topCard.top + topCard.height + DENSE_CARD_GAP > bottomCard.top &&
    bottomCard.top + bottomCard.height + DENSE_CARD_GAP > topCard.top
  );
}

function getCompactCardHeight(card, isCrowded) {
  const height = getFiniteNumber(card.height, DENSE_CARD_MIN_HEIGHT);
  if (!isCrowded || height > DENSE_CARD_MAX_COMPACT_HEIGHT) return height;
  return Math.max(DENSE_CARD_MIN_HEIGHT, height - DENSE_CARD_HEIGHT_REDUCTION);
}

function getAdjustedTitleFontSize(card, height) {
  const fontSize = getFiniteNumber(card.titleFontSize, 12);
  const availableTitleHeight = Math.max(1, height - CARD_VERTICAL_CHROME_PX);
  const heightCapped = availableTitleHeight / (CARD_TITLE_LINE_HEIGHT * CARD_TITLE_MAX_LINES);
  return Math.max(1, Math.min(fontSize, heightCapped));
}

function nudgeCrowdedPair(topCard, bottomCard) {
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

function getDenseCardZIndex(card, isCrowded) {
  if (!isCrowded) return 1;
  return 20 + Math.max(0, 10 - Math.min(card.sentenceCount || 0, 10));
}

function adjustCrowdedLevelCards(levelCards) {
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

function getAdjustedHierarchyCards(cards) {
  const cardsByLevel = new Map();
  cards.forEach((card) => {
    const levelCards = cardsByLevel.get(card.levelIndex) || [];
    levelCards.push(card);
    cardsByLevel.set(card.levelIndex, levelCards);
  });

  return Array.from(cardsByLevel.values())
    .flatMap(adjustCrowdedLevelCards)
    .sort(
      (left, right) =>
        left.levelIndex - right.levelIndex ||
        left.top - right.top ||
        left.fullPath.localeCompare(right.fullPath),
    );
}

function getSummaryFontSizes(anchorCard) {
  const anchorTitleSize = getFiniteNumber(anchorCard?.titleFontSize, BASE_TOPIC_TITLE_FONT_SIZE);
  const zoomMultiplier = Math.max(1, anchorTitleSize / BASE_TOPIC_TITLE_FONT_SIZE);

  return {
    title: SUMMARY_TITLE_FONT_SIZE * zoomMultiplier,
    text: SUMMARY_TEXT_FONT_SIZE * zoomMultiplier,
  };
}

/**
 * @typedef {Object} CanvasTopicCard
 * @property {string} key
 * @property {string} fullPath
 * @property {string} displayName
 * @property {number} sentenceCount
 * @property {number} startSentence
 * @property {number} endSentence
 * @property {number} top
 * @property {number} height
 * @property {number} titleFontSize
 * @property {number} depth
 * @property {number} levelIndex
 * @property {number} right
 */

/**
 * @param {{
 *   show: boolean,
 *   selectedLevel: number,
 *   topicCards: Array<{
 *     key: string,
 *     fullPath: string,
 *     displayName: string,
 *     sentenceCount: number,
 *     startSentence: number,
 *     endSentence: number,
 *     top: number,
 *     height: number,
 *     titleFontSize: number,
 *     depth: number,
 *     levelIndex: number,
 *     right: number,
 *   }>,
 *   railWidth: number,
 *   cardWidth: number,
 *   activeTopicKey: string | null,
 *   selectedTopicKey: string | null,
 *   onTopicEnter: (topicKey: string) => void,
 *   onTopicLeave: (topicKey: string) => void,
 *   onTopicClick: (topicKey: string, card: CanvasTopicCard) => void,
 *   readTopics: Set<string> | string[] | null,
 *   onToggleRead: ((topicKey: string) => void) | null,
 *   currentTopicSummary: {
 *     path: string,
 *     text: string,
 *   } | null,
 * }} props
 */
function CanvasTopicHierarchyRail({
  show,
  selectedLevel,
  topicCards,
  railWidth,
  cardWidth,
  activeTopicKey,
  selectedTopicKey,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  readTopics,
  onToggleRead,
  currentTopicSummary,
}) {
  const safeReadTopics = readTopics instanceof Set ? readTopics : new Set(readTopics || []);
  const hierarchyCards = React.useMemo(
    () =>
      (Array.isArray(topicCards) ? topicCards : [])
        .filter((card) => card.levelIndex <= selectedLevel)
        .sort(
          (left, right) =>
            left.levelIndex - right.levelIndex ||
            left.top - right.top ||
            left.fullPath.localeCompare(right.fullPath),
        ),
    [selectedLevel, topicCards],
  );
  const adjustedHierarchyCards = React.useMemo(
    () => getAdjustedHierarchyCards(hierarchyCards),
    [hierarchyCards],
  );
  const summaryAnchorCard = currentTopicSummary
    ? adjustedHierarchyCards.find((card) => card.fullPath === currentTopicSummary.path)
    : null;
  const summaryTop = summaryAnchorCard ? summaryAnchorCard.top : 0;
  const summaryFontSizes = getSummaryFontSizes(summaryAnchorCard);

  // Publish the rendered height of the current-topic summary card so the sticky
  // CSS can clamp its bottom edge to the visible viewport (see modal.css). The
  // card's height depends on its text and zoom-adjusted font size, so we
  // remeasure whenever either changes.
  const summaryRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    el.style.setProperty('--current-summary-height', `${el.offsetHeight}px`);
  }, [currentTopicSummary, summaryFontSizes.title, summaryFontSizes.text]);

  if (!show) return null;

  return (
    <>
      {currentTopicSummary && (
        <aside
          ref={summaryRef}
          className="canvas-topic-current-summary"
          aria-label="Current topic summary"
          style={{
            // Core placement is set inline so the card stays pinned to the left
            // (opposite the right-hand rail) even if modal.css lags behind the
            // JS bundle — otherwise the aside falls into the flex flow and lands
            // on top of the rail. The CSS rule layers on width/transition.
            position: 'absolute',
            left: 0,
            top: summaryTop,
            '--current-summary-top': `${summaryTop}px`,
            '--current-summary-title-font-size': `${summaryFontSizes.title}px`,
            '--current-summary-text-font-size': `${summaryFontSizes.text}px`,
          }}
        >
          <article className="canvas-summary-view__card is-active">
            <header className="canvas-summary-view__card-header">
              <span className="canvas-summary-view__card-path">{currentTopicSummary.path}</span>
            </header>
            {currentTopicSummary.text && (
              <p className="canvas-summary-view__card-text">{currentTopicSummary.text}</p>
            )}
          </article>
        </aside>
      )}
      <aside
        className="canvas-topic-hierarchy"
        aria-label="Topic hierarchy"
        onMouseDown={(event) => {
          if (event.target.closest('button, a, input, select, textarea')) {
            event.stopPropagation();
          }
        }}
        style={{
          '--canvas-topic-hierarchy-width': `${railWidth}px`,
          '--topic-card-width': `${cardWidth}px`,
        }}
      >
        <div
          className="canvas-topic-hierarchy__body"
          style={{
            height: adjustedHierarchyCards.length
              ? `${Math.max(...adjustedHierarchyCards.map((c) => c.top + c.height)) + 20}px`
              : 'auto',
          }}
        >
          {hierarchyCards.length === 0 ? (
            <p className="canvas-topic-hierarchy__empty">No topics at this level.</p>
          ) : (
            <>
              {adjustedHierarchyCards.map((card) => {
                const isActive = activeTopicKey === card.fullPath;
                const isSelected = selectedTopicKey === card.fullPath;
                const isRead = isTopicRead(card.fullPath, safeReadTopics);
                const classes = [
                  'canvas-topic-hierarchy__card',
                  card.levelIndex === 0
                    ? 'canvas-topic-hierarchy__card--root'
                    : 'canvas-topic-hierarchy__card--child',
                  isActive ? 'is-active' : '',
                  isSelected ? 'is-selected' : '',
                  isRead ? 'is-read' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                const sourceCard = card.sourceCard || card;

                return (
                  <button
                    key={card.key}
                    type="button"
                    className={classes}
                    style={{
                      '--topic-card-top': `${card.top}px`,
                      '--topic-card-height': `${card.height}px`,
                      '--topic-card-title-font-size': `${card.titleFontSize}px`,
                      '--topic-card-right': `${card.right}px`,
                      '--topic-accent-color': getHierarchyTopicAccentColor(
                        card.fullPath,
                        card.depth,
                      ),
                      zIndex: isSelected ? 60 : isActive ? 50 : card.zIndex,
                    }}
                    onMouseEnter={() => onTopicEnter(card.fullPath)}
                    onMouseLeave={() => onTopicLeave(card.fullPath)}
                    onClick={() => {
                      onTopicClick(card.fullPath, sourceCard);
                      if (onToggleRead) {
                        onToggleRead(card.fullPath);
                      }
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (onToggleRead) {
                        onToggleRead(card.fullPath);
                      }
                    }}
                    title={`${card.fullPath}: sentences ${card.startSentence}-${card.endSentence}`}
                  >
                    <div className="canvas-topic-hierarchy__card-content">
                      <span className="canvas-topic-hierarchy__card-name">{card.displayName}</span>
                      <span className="canvas-topic-hierarchy__card-meta">
                        {card.sentenceCount} sent.
                      </span>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default React.memo(CanvasTopicHierarchyRail);
