import React from 'react';
import { getHierarchyTopicAccentColor } from '../utils/topicColorUtils.js';
import { isTopicRead } from '../utils/topicReadUtils.js';
import {
  CARD_COMPACT_TITLE_MAX_LINES,
  getAdjustedHierarchyCards,
  getAdjustedTitleFontSize,
  getCardLabelHeight,
  getSummaryFontSizes,
  getTitleLineBudget,
} from '../utils/denseCardLayout.js';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from './YouTubeTimestampButton.jsx';

// Accent colors are a pure function of (fullPath, depth) and never change once a
// card exists, but hashing the path on every render — for every card, on every
// hover/zoom — is wasted work. Memoize across renders so the rail only hashes a
// path once for its lifetime.
const accentColorCache = new Map();
function getCachedAccentColor(fullPath, depth) {
  const cacheKey = `${fullPath}|${depth}`;
  let color = accentColorCache.get(cacheKey);
  if (color === undefined) {
    color = getHierarchyTopicAccentColor(fullPath, depth);
    accentColorCache.set(cacheKey, color);
  }
  return color;
}

// One rail card, memoized so a hover (which flips is-active/is-selected on at
// most two cards) re-renders only those cards instead of the whole column.
// `card`, the handlers, and `accentColor` are referentially stable across a
// hover render, so the shallow prop compare skips every untouched card.
const TopicCard = React.memo(function TopicCard({
  card,
  isActive,
  isSelected,
  isRead,
  accentColor,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  onToggleRead,
}) {
  const titleLineBudget = getTitleLineBudget(card.height);
  const classes = [
    'canvas-topic-hierarchy__card',
    card.levelIndex === 0
      ? 'canvas-topic-hierarchy__card--root'
      : 'canvas-topic-hierarchy__card--child',
    titleLineBudget === CARD_COMPACT_TITLE_MAX_LINES ? 'is-compact' : '',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
    isRead ? 'is-read' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const sourceCard = card.sourceCard || card;

  return (
    <button
      type="button"
      className={classes}
      style={{
        '--topic-card-top': `${card.top}px`,
        '--topic-card-height': `${card.height}px`,
        '--topic-card-title-font-size': `${card.titleFontSize}px`,
        '--topic-card-title-line-clamp': titleLineBudget,
        '--topic-card-label-height': `${getCardLabelHeight(card)}px`,
        '--topic-card-right': `${card.right}px`,
        '--topic-accent-color': accentColor,
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
        <span className="canvas-topic-hierarchy__card-meta">{card.sentenceCount} sent.</span>
      </div>
    </button>
  );
});

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
 *     sourceSentences?: number[],
 *   } | null,
 *   sentences?: string[],
 *   sourceUrl?: string,
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
  sentences,
  sourceUrl,
}) {
  const safeReadTopics = React.useMemo(
    () => (readTopics instanceof Set ? readTopics : new Set(readTopics || [])),
    [readTopics],
  );
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
  // Collision resolution (3 passes + sorts over every card) is the heavy part of
  // the layout, and its geometry — top/height/zIndex — depends only on the cards'
  // sentence positions and the selected level, NOT on zoom. Zoom merely changes
  // each card's `titleFontSize`/`right`, which produces a fresh `hierarchyCards`
  // array every zoom step. Key the collision on a signature of the geometry
  // fields alone so it is skipped while only the zoom-dependent fields change.
  const geometrySignature = React.useMemo(
    () => hierarchyCards.map((c) => `${c.key}:${c.top}:${c.height}:${c.levelIndex}`).join('|'),
    [hierarchyCards],
  );
  const geometryCards = React.useMemo(
    () => getAdjustedHierarchyCards(hierarchyCards),
    // Intentionally keyed on the geometry signature, not the array reference, so
    // zoom (which only touches titleFontSize/right) reuses the cached geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometrySignature],
  );
  const hierarchyCardsByKey = React.useMemo(() => {
    const map = new Map();
    hierarchyCards.forEach((card) => map.set(card.key, card));
    return map;
  }, [hierarchyCards]);
  // Re-apply the zoom-dependent fields onto the cached geometry. `titleFontSize`
  // is the parent's already zoom-scaled base, re-capped to the final (possibly
  // compacted) card height — identical to running the full pipeline, minus the
  // collision cost.
  const adjustedHierarchyCards = React.useMemo(
    () =>
      geometryCards.map((card) => {
        const source = hierarchyCardsByKey.get(card.key) || card.sourceCard || card;
        return {
          ...card,
          titleFontSize: getAdjustedTitleFontSize(
            { titleFontSize: source.titleFontSize },
            card.height,
          ),
          right: source.right,
        };
      }),
    [geometryCards, hierarchyCardsByKey],
  );
  // Body height is pure geometry, so derive it from the cached set to stay stable
  // across zoom.
  const bodyHeight = React.useMemo(
    () =>
      geometryCards.length
        ? `${Math.max(...geometryCards.map((c) => c.top + c.height)) + 20}px`
        : 'auto',
    [geometryCards],
  );
  const summaryAnchorCard = currentTopicSummary
    ? adjustedHierarchyCards.find((card) => card.fullPath === currentTopicSummary.path)
    : null;
  const hasCurrentTopicSummary = Boolean(currentTopicSummary);
  const summaryTop = summaryAnchorCard ? summaryAnchorCard.top : 0;
  const summaryFontSizes = getSummaryFontSizes(summaryAnchorCard);
  const isYouTube = React.useMemo(() => Boolean(getYouTubeVideoId(sourceUrl)), [sourceUrl]);
  const summaryYouTubeLink = React.useMemo(
    () =>
      isYouTube && currentTopicSummary
        ? getYouTubeTimestampLink({
            sourceUrl,
            sentences,
            sourceSentences: currentTopicSummary.sourceSentences,
          })
        : null,
    [isYouTube, currentTopicSummary, sourceUrl, sentences],
  );

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
            '--current-summary-youtube-font-size': `${summaryFontSizes.youtube}px`,
            '--current-summary-highlight-color': 'var(--pagetollm-highlight-color)',
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
              <YouTubeTimestampButton link={summaryYouTubeLink} />
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
        <div className="canvas-topic-hierarchy__body" style={{ height: bodyHeight }}>
          {hierarchyCards.length === 0 ? (
            <p className="canvas-topic-hierarchy__empty">No topics at this level.</p>
          ) : (
            <>
              {adjustedHierarchyCards.map((card) => (
                <TopicCard
                  key={card.key}
                  card={card}
                  isActive={activeTopicKey === card.fullPath}
                  isSelected={selectedTopicKey === card.fullPath}
                  isRead={isTopicRead(card.fullPath, safeReadTopics)}
                  accentColor={getCachedAccentColor(card.fullPath, card.depth)}
                  onTopicEnter={onTopicEnter}
                  onTopicLeave={onTopicLeave}
                  onTopicClick={onTopicClick}
                  onToggleRead={onToggleRead}
                />
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export default React.memo(CanvasTopicHierarchyRail);
