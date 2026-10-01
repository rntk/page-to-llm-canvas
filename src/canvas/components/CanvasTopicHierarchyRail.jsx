import React from 'react';
import TopicActionsMenu from '../../components/TopicActionsMenu.jsx';
import { getHierarchyTopicAccentColor } from '../../domain/topicColorUtils.js';
import { CARD_COMPACT_TITLE_MAX_LINES } from '../../utils/cardTitleGeometry.js';
import {
  getAdjustedHierarchyCards,
  getAdjustedTitleFontSize,
  getCardLabelHeight,
  getFloatingSummaryFontSizes,
  getSummaryFontSizes,
  getTitleLineBudget,
} from '../../utils/denseCardLayout.js';
import { getZoomAdjustedTitleFontSize } from '../../domain/topicCards.js';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import { getCardEnterDelay } from '../../utils/cardEntrance.js';
import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';

// Briefly animate late geometry changes without animating every zoom or level switch.
const SETTLE_TRANSITION_MS = 320;

function isElementVerticallyInBounds(elementRect, boundsRect) {
  return elementRect.bottom > boundsRect.top && elementRect.top < boundsRect.bottom;
}

// Stable props let a hover re-render only the affected cards.
const TopicCard = React.memo(function TopicCard({
  card,
  isActive,
  isSelected,
  accentColor,
  isYouTube,
  sourceUrl,
  sentences,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  topicActions,
  cardRef,
  enterDelay,
}) {
  const titleLineBudget = getTitleLineBudget(card.height);
  // At low zoom, cap single-line titles against one line of available height.
  const titleFontCap =
    getAdjustedTitleFontSize({ titleFontSize: Number.MAX_SAFE_INTEGER }, card.height) *
    titleLineBudget;
  // Card objects change on zoom; the timestamp scan only needs the starting sentence.
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
  // Counter-scale the link on zoom, capped to the rail card's height.
  const youtubeFontSize = youtubeLink
    ? getSummaryFontSizes({ titleFontSize: card.titleFontSize }).youtube
    : null;
  const youtubeFontCap = youtubeLink
    ? getSummaryFontSizes({ titleFontSize: titleFontCap }).youtube
    : null;
  // Keep the actions trigger tappable on zoom, within the card's height budget.
  const actionsFontSize = getSummaryFontSizes({ titleFontSize: card.titleFontSize }).actions;
  const actionsFontCap = getSummaryFontSizes({ titleFontSize: titleFontCap }).actions;
  const classes = [
    'canvas-topic-hierarchy__card',
    card.levelIndex === 0
      ? 'canvas-topic-hierarchy__card--root'
      : 'canvas-topic-hierarchy__card--child',
    titleLineBudget === CARD_COMPACT_TITLE_MAX_LINES ? 'is-compact' : '',
    isActive ? 'is-active' : '',
    isSelected ? 'is-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const sourceCard = card.sourceCard || card;

  return (
    <div
      ref={cardRef}
      className={classes}
      style={{
        '--topic-card-top': `${card.top}px`,
        '--topic-card-height': `${card.height}px`,
        '--topic-card-title-font-size': `${card.titleFontSize}px`,
        '--topic-card-title-max-font-size': `${titleFontCap}px`,
        '--topic-card-title-line-clamp': titleLineBudget,
        '--topic-card-label-height': `${getCardLabelHeight(card)}px`,
        '--topic-card-right': `${card.right}px`,
        '--topic-card-live-right': `var(--topic-card-level-${card.levelIndex}-right, ${card.right}px)`,
        '--topic-accent-color': accentColor,
        ...(enterDelay ? { '--topic-card-enter-delay': `${enterDelay}ms` } : {}),
        ...(youtubeFontSize != null && {
          '--topic-card-youtube-font-size': `${youtubeFontSize}px`,
          '--topic-card-youtube-max-font-size': `${youtubeFontCap}px`,
        }),
        '--topic-card-actions-font-size': `${actionsFontSize}px`,
        '--topic-card-actions-max-font-size': `${actionsFontCap}px`,
        zIndex: isSelected ? 60 : isActive ? 50 : card.zIndex,
      }}
      onMouseEnter={() => onTopicEnter({ path: card.fullPath, cardKey: sourceCard.key })}
      onMouseLeave={() => onTopicLeave({ path: card.fullPath, cardKey: sourceCard.key })}
    >
      <button
        type="button"
        className="canvas-topic-hierarchy__card-main"
        onClick={() => onTopicClick({ path: card.fullPath, cardKey: sourceCard.key }, sourceCard)}
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
      {topicActions?.length > 0 && (
        <TopicActionsMenu
          actions={topicActions}
          classPrefix="canvas-topic-hierarchy"
          topic={{
            path: card.fullPath,
            startSentence: card.startSentence,
            endSentence: card.endSentence,
          }}
        />
      )}
    </div>
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
 */
function CanvasTopicHierarchyRail({ show, ...props }) {
  // The rail stays in App's tree so it can be shown immediately, but its card
  // layout is expensive. Do not mount the hook-heavy body until it is visible.
  if (!show) return null;
  return <CanvasTopicHierarchyRailBody {...props} />;
}

/**
 * @param {object} props
 * @param {number} props.selectedLevel
 * @param {Array<CanvasTopicCard>} props.topicCards
 * @param {number} props.railWidth
 * @param {number} props.cardWidth
 * @param {{path: string, cardKey: ?string}|null} props.activeTopic
 * @param {{path: string, cardKey: ?string}|null} props.selectedTopic
 * @param {function({path: string, cardKey: ?string}): void} props.onTopicEnter
 * @param {function({path: string, cardKey: ?string}): void} props.onTopicLeave
 * @param {function({path: string, cardKey: ?string}, CanvasTopicCard): void} props.onTopicClick
 * @param {Array<{id: string, label: string, onSelect: Function, title?: Function}>} [props.topicActions]
 * @param {?function(): void} props.onCancelTopicSelection
 * @param {?object} props.currentTopicSummary
 * @param {string} [props.currentTopicSummary.key]
 * @param {string} props.currentTopicSummary.path
 * @param {string} props.currentTopicSummary.text
 * @param {number[]} [props.currentTopicSummary.sourceSentences]
 * @param {string[]} [props.sentences]
 * @param {string} [props.sourceUrl]
 * @param {number} [props.scale] canvas zoom scale; drives the summary card fonts
 * @param {boolean} [props.isEntering] true while the canvas is being revealed;
 *   plays the staggered card entrance and suppresses the settle transition
 * @param {string} [props.layoutKey] identity of the current mode/level layout;
 *   a change means the card set was swapped deliberately, not remeasured
 */
const CanvasTopicHierarchyRailBody = React.memo(function CanvasTopicHierarchyRailBody({
  selectedLevel,
  topicCards,
  railWidth,
  cardWidth,
  activeTopic,
  selectedTopic,
  onTopicEnter,
  onTopicLeave,
  onTopicClick,
  topicActions = [],
  onCancelTopicSelection,
  currentTopicSummary,
  sentences,
  sourceUrl,
  scale,
  isEntering = false,
  layoutKey = '',
}) {
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
  const colorSignature = React.useMemo(
    () => hierarchyCards.map((card) => `${card.fullPath}|${card.depth}`).join('\n'),
    [hierarchyCards],
  );
  // Cache colors by path and depth so zoom-only card changes reuse them.
  const accentColors = React.useMemo(() => {
    const colors = new Map();
    hierarchyCards.forEach((card) => {
      const key = `${card.fullPath}|${card.depth}`;
      if (!colors.has(key)) {
        colors.set(key, getHierarchyTopicAccentColor(card.fullPath, card.depth));
      }
    });
    return colors;
    // Card objects change on zoom; color inputs do not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorSignature]);
  // Collision geometry is zoom-independent. Include every field read by
  // getAdjustedHierarchyCards, including sentenceCount and startSentence.
  const geometrySignature = React.useMemo(
    () =>
      hierarchyCards
        .map(
          (c) =>
            `${c.key}:${c.top}:${c.height}:${c.levelIndex}:${c.sentenceCount}:${c.startSentence}`,
        )
        .join('|'),
    [hierarchyCards],
  );
  const geometryCards = React.useMemo(
    () => getAdjustedHierarchyCards(hierarchyCards),
    // Reuse collision geometry when zoom only changes titleFontSize/right.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [geometrySignature],
  );
  const hierarchyCardsByKey = React.useMemo(() => {
    const map = new Map();
    hierarchyCards.forEach((card) => map.set(card.key, card));
    return map;
  }, [hierarchyCards]);
  const hasActiveTopicCardKey = Boolean(
    activeTopic?.cardKey && hierarchyCardsByKey.has(activeTopic.cardKey),
  );
  const hasSelectedTopicCardKey = Boolean(
    selectedTopic?.cardKey && hierarchyCardsByKey.has(selectedTopic.cardKey),
  );
  // Apply zoom fields to cached geometry, capping titles to the final card height.
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
  // Keep body height stable across zoom.
  const bodyHeight = React.useMemo(
    () =>
      geometryCards.length
        ? `${geometryCards.reduce((max, c) => Math.max(max, c.top + c.height), -Infinity) + 20}px`
        : 'auto',
    [geometryCards],
  );
  // Briefly glide cards after a late remeasure.
  const [isSettling, setIsSettling] = React.useState(false);
  const previousLayoutRef = React.useRef(null);
  React.useEffect(() => {
    const previous = previousLayoutRef.current;
    previousLayoutRef.current = { geometrySignature, layoutKey };
    const shouldSettle =
      // The entrance animation owns the first reveal.
      previous !== null &&
      !isEntering &&
      previous.geometrySignature !== geometrySignature &&
      // Mode and level switches use canvas alignment; only remeasures glide.
      previous.layoutKey === layoutKey;
    if (!shouldSettle) {
      // A mid-glide switch cancels the timer, so clear its flag here.
      setIsSettling(false);
      return undefined;
    }
    setIsSettling(true);
    const timer = setTimeout(() => setIsSettling(false), SETTLE_TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [geometrySignature, layoutKey, isEntering]);

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
  // The floating summary scales with zoom, independent of its anchor's height cap.
  const summaryFontSizes = React.useMemo(
    () => getFloatingSummaryFontSizes(getZoomAdjustedTitleFontSize(scale)),
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

  // Publish summary height for the viewport clamp in modal.css.
  const summaryRef = React.useRef(null);
  const summaryAnchorCardRef = React.useRef(null);
  const [isSummaryAnchorInView, setIsSummaryAnchorInView] = React.useState(true);
  const setSummaryAnchorCardRef = React.useCallback((element) => {
    summaryAnchorCardRef.current = element;
  }, []);

  // Panning bypasses React; watch canvas styles to hide offscreen summaries.
  React.useLayoutEffect(() => {
    const anchor = summaryAnchorCardRef.current;
    const canvasArea = anchor?.closest('.canvas-area');
    const canvasViewport = anchor?.closest('.canvas-viewport');
    // Keep the summary visible while its anchor is briefly unavailable.
    if (!summaryAnchorCard || !anchor || !canvasArea) {
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
  }, [summaryAnchorCard]);

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
    if (!onCancelTopicSelection || (!selectedTopic && !hasCurrentTopicSummary)) {
      return undefined;
    }

    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancelTopicSelection();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedTopic, hasCurrentTopicSummary, onCancelTopicSelection]);

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
                <span key={currentTopicSummary.key} className="canvas-summary-view__card-path">
                  {currentTopicSummary.path}
                </span>
              </div>
              <YouTubeTimestampButton link={summaryYouTubeLink} />
            </header>
            {currentTopicSummary.text && (
              <p key={currentTopicSummary.key} className="canvas-summary-view__card-text">
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
          '--canvas-topic-hierarchy-width-fallback': `${railWidth}px`,
          '--topic-card-width-fallback': `${cardWidth}px`,
        }}
      >
        <div
          className={`canvas-topic-hierarchy__body${isEntering ? ' is-entering' : ''}${
            isSettling ? ' is-settling' : ''
          }`}
          style={{ height: bodyHeight }}
        >
          {hierarchyCards.length === 0 ? (
            <p className="canvas-topic-hierarchy__empty">No topics at this level.</p>
          ) : (
            <>
              {adjustedHierarchyCards.map((card, index) => (
                <TopicCard
                  key={card.key}
                  card={card}
                  enterDelay={
                    isEntering ? getCardEnterDelay(index, adjustedHierarchyCards.length) : 0
                  }
                  isActive={
                    hasActiveTopicCardKey
                      ? activeTopic.cardKey === card.key
                      : activeTopic?.path === card.fullPath
                  }
                  isSelected={
                    hasSelectedTopicCardKey
                      ? selectedTopic.cardKey === card.key
                      : selectedTopic?.path === card.fullPath
                  }
                  accentColor={accentColors.get(`${card.fullPath}|${card.depth}`)}
                  isYouTube={isYouTube}
                  sourceUrl={sourceUrl}
                  sentences={sentences}
                  cardRef={summaryAnchorCard?.key === card.key ? setSummaryAnchorCardRef : null}
                  onTopicEnter={onTopicEnter}
                  onTopicLeave={onTopicLeave}
                  onTopicClick={onTopicClick}
                  topicActions={topicActions}
                />
              ))}
            </>
          )}
        </div>
      </aside>
    </>
  );
});

export default CanvasTopicHierarchyRail;
