import React from 'react';
import { getHierarchyTopicAccentColor } from '../utils/topicColorUtils.js';
import { isTopicRead } from '../utils/topicReadUtils.js';
import {
  CARD_COMPACT_TITLE_MAX_LINES,
  getAdjustedHierarchyCards,
  getCardLabelHeight,
  getSummaryFontSizes,
  getTitleLineBudget,
} from '../utils/denseCardLayout.js';

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
 *   onCancelTopicSelection: (() => void) | null,
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
  onCancelTopicSelection,
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
  const hasCurrentTopicSummary = Boolean(currentTopicSummary);
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
  }, [currentTopicSummary, summaryFontSizes.kicker, summaryFontSizes.title, summaryFontSizes.text]);

  React.useEffect(() => {
    if (!show || !onCancelTopicSelection || (!selectedTopicKey && !hasCurrentTopicSummary)) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelTopicSelection();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [show, selectedTopicKey, hasCurrentTopicSummary, onCancelTopicSelection]);

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
            '--current-summary-kicker-font-size': `${summaryFontSizes.kicker}px`,
            '--current-summary-title-font-size': `${summaryFontSizes.title}px`,
            '--current-summary-text-font-size': `${summaryFontSizes.text}px`,
          }}
        >
          <article className="canvas-summary-view__card is-active">
            <header className="canvas-summary-view__card-header canvas-summary-view__card-header--stacked">
              <div className="canvas-summary-view__card-title-block">
                <span className="canvas-summary-view__card-kicker">Summary</span>
                <span key={currentTopicSummary.path} className="canvas-summary-view__card-path">
                  {currentTopicSummary.path}
                </span>
              </div>
            </header>
            {currentTopicSummary.text && (
              <p key={currentTopicSummary.path} className="canvas-summary-view__card-text">
                {currentTopicSummary.text}
              </p>
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
                  getTitleLineBudget(card.height) === CARD_COMPACT_TITLE_MAX_LINES
                    ? 'is-compact'
                    : '',
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
                      '--topic-card-title-line-clamp': getTitleLineBudget(card.height),
                      '--topic-card-label-height': `${getCardLabelHeight(card)}px`,
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
