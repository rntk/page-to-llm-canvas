import React from 'react';
import { getHierarchyTopicAccentColor } from '../../utils/topicColorUtils.js';
import { isTopicRead } from '../../utils/topicReadUtils.js';
import {
  CARD_COMPACT_TITLE_MAX_LINES,
  getAdjustedHierarchyCards,
  getAdjustedTitleFontSize,
  getCardLabelHeight,
  getSummaryFontSizes,
  getTitleLineBudget,
} from '../../utils/denseCardLayout.js';
import { getSummaryAnchorTitleFontSize } from '../../domain/topicCards.js';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';

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

function isElementVerticallyInBounds(elementRect, boundsRect) {
  return elementRect.bottom > boundsRect.top && elementRect.top < boundsRect.bottom;
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
  isYouTube,
  sourceUrl,
  sentences,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  onToggleRead,
  cardRef,
}) {
  const titleLineBudget = getTitleLineBudget(card.height);
  // Scoped to startSentence (not the whole card object, which gets a fresh
  // reference every zoom step) so the backward timestamp scan only reruns
  // when the card or transcript actually changes.
  const youtubeLink = React.useMemo(
    () =>
      isYouTube
        ? getYouTubeTimestampLink({
            sourceUrl,
            sentences,
            sourceSentences: [card.startSentence],
          })
        : null,
    [isYouTube, sourceUrl, sentences, card.startSentence],
  );
  // A flat px font-size shrinks with the canvas transform on zoom-out and
  // becomes unreadable, unlike the title, which counter-scales via
  // card.titleFontSize. Reuse the same titleFontSize-driven multiplier
  // (see getSummaryFontSizes) so the link scales the same way. This link lives
  // inside the card and must fit its height, so passing the card's own (height-
  // capped) size is right here — unlike the floating summary card below, which
  // deliberately scales on zoom alone.
  const youtubeFontSize = youtubeLink
    ? getSummaryFontSizes({ titleFontSize: card.titleFontSize }).youtube
    : null;
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
      ref={cardRef}
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
        ...(youtubeFontSize != null && {
          '--topic-card-youtube-font-size': `${youtubeFontSize}px`,
        }),
        zIndex: isSelected ? 60 : isActive ? 50 : card.zIndex,
      }}
      onMouseEnter={() => onTopicEnter(card.fullPath, sourceCard.key)}
      onMouseLeave={() => onTopicLeave(card.fullPath, sourceCard.key)}
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
        <span className="canvas-topic-hierarchy__card-meta-row">
          <span className="canvas-topic-hierarchy__card-meta">{card.sentenceCount} sent.</span>
          {youtubeLink && <YouTubeTimestampButton link={youtubeLink} />}
        </span>
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
 * @param {object} props
 * @param {boolean} props.show
 * @param {number} props.selectedLevel
 * @param {Array<CanvasTopicCard>} props.topicCards
 * @param {number} props.railWidth
 * @param {number} props.cardWidth
 * @param {?string} props.activeTopicKey
 * @param {?string} [props.activeTopicCardKey]
 * @param {?string} props.selectedTopicKey
 * @param {?string} [props.selectedTopicCardKey]
 * @param {function(string, string=): void} props.onTopicEnter
 * @param {function(string, string=): void} props.onTopicLeave
 * @param {function(string, CanvasTopicCard): void} props.onTopicClick
 * @param {?function(): void} props.onCancelTopicSelection
 * @param {Set<string> | string[] | null} props.readTopics
 * @param {?function(string): void} props.onToggleRead
 * @param {?object} props.currentTopicSummary
 * @param {string} [props.currentTopicSummary.key]
 * @param {string} props.currentTopicSummary.path
 * @param {string} props.currentTopicSummary.text
 * @param {number[]} [props.currentTopicSummary.sourceSentences]
 * @param {string[]} [props.sentences]
 * @param {string} [props.sourceUrl]
 * @param {number} [props.scale] canvas zoom scale; drives the summary card fonts
 */
function CanvasTopicHierarchyRail({
  show,
  selectedLevel,
  topicCards,
  railWidth,
  cardWidth,
  activeTopicKey,
  activeTopicCardKey,
  selectedTopicKey,
  selectedTopicCardKey,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  onCancelTopicSelection,
  readTopics,
  onToggleRead,
  currentTopicSummary,
  sentences,
  sourceUrl,
  scale,
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
  // array every zoom step. Keep this signature in sync with every input field
  // read by getAdjustedHierarchyCards/adjustCrowdedLevelCards in denseCardLayout
  // (including sentenceCount, which getDenseCardZIndex reads to pick a card's
  // z-index — omitting it would serve a stale z-index after a sentence-count-only
  // change).
  const geometrySignature = React.useMemo(
    () =>
      hierarchyCards
        .map((c) => `${c.key}:${c.top}:${c.height}:${c.levelIndex}:${c.sentenceCount}`)
        .join('|'),
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
  const hasActiveTopicCardKey = Boolean(
    activeTopicCardKey && hierarchyCardsByKey.has(activeTopicCardKey),
  );
  const hasSelectedTopicCardKey = Boolean(
    selectedTopicCardKey && hierarchyCardsByKey.has(selectedTopicCardKey),
  );
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
        ? `${geometryCards.reduce((max, c) => Math.max(max, c.top + c.height), -Infinity) + 20}px`
        : 'auto',
    [geometryCards],
  );
  const summaryAnchorCard = React.useMemo(
    () =>
      currentTopicSummary
        ? adjustedHierarchyCards.find((card) => card.key === currentTopicSummary.key) ||
          adjustedHierarchyCards.find((card) => card.fullPath === currentTopicSummary.path)
        : null,
    [currentTopicSummary, adjustedHierarchyCards],
  );
  const hasCurrentTopicSummary = Boolean(currentTopicSummary);
  const summaryTop = summaryAnchorCard ? summaryAnchorCard.top : 0;
  // Zoom-only, deliberately NOT derived from `summaryAnchorCard`: the anchor's
  // titleFontSize is capped to its own (possibly compacted) card height, which
  // made the floating summary render at a different size — sometimes too small
  // to read — depending on which topic it described at one and the same zoom
  // level. See getSummaryAnchorTitleFontSize.
  const summaryFontSizes = React.useMemo(
    () => getSummaryFontSizes({ titleFontSize: getSummaryAnchorTitleFontSize(scale) }),
    [scale],
  );
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
  const summaryAnchorCardRef = React.useRef(null);
  const [isSummaryAnchorInView, setIsSummaryAnchorInView] = React.useState(true);
  const setSummaryAnchorCardRef = React.useCallback((element) => {
    summaryAnchorCardRef.current = element;
  }, []);

  // Canvas panning updates CSS custom properties directly, bypassing React
  // renders. Watch the transformed canvas viewport's style and compare the
  // matched rail card with the canvas bounds so an old summary is unmounted as
  // soon as its topic/sentences leave view.
  React.useLayoutEffect(() => {
    const anchor = summaryAnchorCardRef.current;
    const canvasArea = anchor?.closest('.canvas-area');
    const canvasViewport = anchor?.closest('.canvas-viewport');
    // A missing anchor can occur briefly while the card list is changing. Keep
    // the existing summary visible until there is a real canvas/card pair to
    // measure, rather than flashing it out on a transient render.
    if (!show || !summaryAnchorCard || !anchor || !canvasArea) {
      setIsSummaryAnchorInView(true);
      return undefined;
    }

    let frame = 0;
    const updateVisibility = () => {
      frame = 0;
      const anchorRect = anchor.getBoundingClientRect();
      const canvasRect = canvasArea.getBoundingClientRect();
      const isInView = isElementVerticallyInBounds(anchorRect, canvasRect);
      setIsSummaryAnchorInView((wasInView) => (wasInView === isInView ? wasInView : isInView));
    };
    const scheduleVisibilityUpdate = () => {
      if (!frame) frame = window.requestAnimationFrame(updateVisibility);
    };

    updateVisibility();
    const styleObserver =
      canvasViewport && typeof window.MutationObserver !== 'undefined'
        ? new window.MutationObserver(scheduleVisibilityUpdate)
        : null;
    styleObserver?.observe(canvasViewport, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    });

    const resizeObserver =
      typeof window.ResizeObserver !== 'undefined'
        ? new window.ResizeObserver(scheduleVisibilityUpdate)
        : null;
    resizeObserver?.observe(canvasArea);
    resizeObserver?.observe(anchor);
    window.addEventListener('resize', scheduleVisibilityUpdate);

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      styleObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleVisibilityUpdate);
    };
  }, [show, summaryAnchorCard]);

  React.useLayoutEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    el.style.setProperty('--current-summary-height', `${el.offsetHeight}px`);
    // `scale` is a dep on its own: it also drives --current-summary-width, so at
    // zoom levels where the font sizes have saturated the text still rewraps and
    // the height changes.
  }, [
    currentTopicSummary,
    scale,
    summaryFontSizes.kicker,
    summaryFontSizes.title,
    summaryFontSizes.text,
  ]);

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
      {currentTopicSummary && isSummaryAnchorInView && (
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
          }}
        >
          <article className="canvas-summary-view__card is-active">
            <header className="canvas-summary-view__card-header canvas-summary-view__card-header--stacked">
              <div className="canvas-summary-view__card-title-block">
                <span className="canvas-summary-view__card-kicker">Summary</span>
                <span
                  key={currentTopicSummary.key || currentTopicSummary.path}
                  className="canvas-summary-view__card-path"
                >
                  {currentTopicSummary.path}
                </span>
              </div>
              <YouTubeTimestampButton link={summaryYouTubeLink} />
            </header>
            {currentTopicSummary.text && (
              <p
                key={currentTopicSummary.key || currentTopicSummary.path}
                className="canvas-summary-view__card-text"
              >
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
                  isActive={
                    hasActiveTopicCardKey
                      ? activeTopicCardKey === card.key
                      : activeTopicKey === card.fullPath
                  }
                  isSelected={
                    hasSelectedTopicCardKey
                      ? selectedTopicCardKey === card.key
                      : selectedTopicKey === card.fullPath
                  }
                  isRead={isTopicRead(card.fullPath, safeReadTopics)}
                  accentColor={getCachedAccentColor(card.fullPath, card.depth)}
                  isYouTube={isYouTube}
                  sourceUrl={sourceUrl}
                  sentences={sentences}
                  cardRef={summaryAnchorCard?.key === card.key ? setSummaryAnchorCardRef : null}
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
