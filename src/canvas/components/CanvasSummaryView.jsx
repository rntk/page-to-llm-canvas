import React from 'react';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';
import useSummaryPreview from '../hooks/useSummaryPreview.js';
import { getCardEnterDelay } from '../../utils/cardEntrance.js';

/**
 * Floating panel of the source article text with the card's sentences highlighted.
 *
 * Presentational: positioning, HTML building and hover intent live in
 * `useSummaryPreview`. The refs are props because the hook's measure effect
 * observes the outer element alongside the summary list.
 */
function SummarySourcePreview({
  card,
  html,
  left,
  top,
  youTubeLink,
  previewRef,
  previewScrollRef,
  onPreviewEnter,
  onPreviewLeave,
}) {
  return (
    <aside
      ref={previewRef}
      id="canvas-summary-source-preview"
      className="canvas-summary-source-preview"
      aria-label="Source sentence preview"
      style={{
        position: 'absolute',
        left,
        top,
        '--summary-source-preview-left': `${left}px`,
        '--summary-source-preview-top': `${top}px`,
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseEnter={onPreviewEnter}
      onMouseLeave={onPreviewLeave}
      onTouchStart={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onWheelCapture={(event) => event.stopPropagation()}
    >
      <article ref={previewScrollRef} className="canvas-summary-source-preview__card">
        <header className="canvas-summary-view__card-header canvas-summary-view__card-header--stacked">
          <div className="canvas-summary-view__card-title-block">
            <span className="canvas-summary-view__card-kicker">Source</span>
            <span className="canvas-summary-view__card-path">{card.path}</span>
          </div>
          <YouTubeTimestampButton link={youTubeLink} />
        </header>
        <div
          className="canvas-summary-source-preview__article pagetollm-article-html"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </article>
    </aside>
  );
}

const SummaryCard = React.memo(function SummaryCard({
  card,
  cardKey,
  registerSummaryCardRef,
  isCardActive,
  isPreviewActive,
  cardYouTubeLink,
  onCardEnter,
  onCardLeave,
  onCardClick,
  onCardKeyDown,
  onShowSourceSentences,
  enterDelay,
}) {
  const hasSummaryContent = Boolean(card.text);
  const canShowSourceSentences = card.sourceSentences.length > 0;
  const cardRef = React.useCallback(
    (el) => {
      registerSummaryCardRef(cardKey, el);
    },
    [cardKey, registerSummaryCardRef],
  );

  return (
    <article
      ref={cardRef}
      className={`canvas-summary-view__card${isCardActive ? ' is-active' : ''}${isPreviewActive ? ' is-source-preview-active' : ''}`}
      // The column mounts at once on each summary-mode switch; staggering turns the flash into a sweep.
      style={enterDelay ? { '--summary-card-enter-delay': `${enterDelay}ms` } : undefined}
      onMouseEnter={() => onCardEnter(card)}
      onMouseLeave={() => onCardLeave(card)}
      onClick={() => onCardClick(card)}
      onKeyDown={onCardKeyDown}
      tabIndex={0}
      aria-expanded={canShowSourceSentences ? isPreviewActive : undefined}
      aria-controls={isPreviewActive ? 'canvas-summary-source-preview' : undefined}
      title={card.path}
    >
      <header className="canvas-summary-view__card-header">
        <span className="canvas-summary-view__card-path">{card.path}</span>
        {card.sourceSentences.length > 0 && (
          <span className="canvas-summary-view__card-meta">
            sentences {card.startSentence} ({card.sourceSentences.length})
          </span>
        )}
      </header>
      {hasSummaryContent && (
        <div className="canvas-summary-view__summary-tooltip-wrap">
          {card.text && <p className="canvas-summary-view__card-text">{card.text}</p>}
          {(canShowSourceSentences || cardYouTubeLink) && (
            <div className="canvas-summary-view__summary-tooltip">
              {canShowSourceSentences && (
                <button
                  type="button"
                  className="canvas-summary-view__summary-tooltip-button"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    onShowSourceSentences(card);
                  }}
                >
                  Show source sentences
                </button>
              )}
              <YouTubeTimestampButton link={cardYouTubeLink} />
            </div>
          )}
        </div>
      )}
    </article>
  );
});

function CanvasSummaryView({
  cards,
  activeTopic,
  hoveredTopic,
  cardRegistry,
  contentRef,
  onTopicEnter,
  onTopicLeave,
  onShowSource,
  onZoomToCard,
  source,
  previewWidth,
}) {
  const { sentences, sourceUrl } = source;
  const {
    previewCard,
    previewCardKey,
    previewHtml,
    previewTop,
    previewLeft,
    previewRef,
    previewScrollRef,
    setSummaryViewRefs,
    hasActiveSummaryCardKey,
    showPreviewForCard,
    handleSummaryCardLeave,
    handleSummaryCardClick,
    handleSummaryCardKeyDown,
    handlePreviewEnter,
    handlePreviewLeave,
  } = useSummaryPreview({
    cards,
    activeTopic,
    hoveredTopic,
    cardRegistry,
    contentRef,
    onTopicEnter,
    onTopicLeave,
    source,
    previewWidth,
  });
  const isYouTube = React.useMemo(() => Boolean(getYouTubeVideoId(sourceUrl)), [sourceUrl]);
  // Resolving a YouTube deep-link scans the sentence array, so compute all links
  // once for both the cards and the preview header rather than per card per render.
  const youTubeLinkByKey = React.useMemo(() => {
    const map = new Map();
    if (!isYouTube) return map;
    cards.forEach((card) => {
      map.set(
        card.key,
        getYouTubeTimestampLink({ sourceUrl, sentences, sourceSentences: card.sourceSentences }),
      );
    });
    return map;
  }, [isYouTube, cards, sourceUrl, sentences]);
  const previewYouTubeLink = previewCardKey ? youTubeLinkByKey.get(previewCardKey) || null : null;
  // Click toggles the source preview (hook) and zooms onto the card. Zoom lives here
  // so it also fires for cards without source sentences, which the preview ignores.
  // The in-card link and button stop propagation, so they never zoom.
  const handleCardClick = React.useCallback(
    (card) => {
      handleSummaryCardClick(card);
      onZoomToCard?.(card);
    },
    [handleSummaryCardClick, onZoomToCard],
  );

  if (cards.length === 0) {
    return (
      <div className="canvas-summary-view" ref={contentRef}>
        <p className="canvas-summary-view__empty">No summaries available at this level.</p>
      </div>
    );
  }

  return (
    <>
      {previewCard && previewHtml && (
        <SummarySourcePreview
          card={previewCard}
          html={previewHtml}
          left={previewLeft}
          top={previewTop}
          youTubeLink={previewYouTubeLink}
          previewRef={previewRef}
          previewScrollRef={previewScrollRef}
          onPreviewEnter={handlePreviewEnter}
          onPreviewLeave={handlePreviewLeave}
        />
      )}
      <div className="canvas-summary-view" ref={setSummaryViewRefs}>
        <div className="canvas-summary-view__cards">
          {cards.map((card, index) => {
            const isActive = activeTopic?.path === card.path;
            const cardKey = card.key;
            const isCardActive = hasActiveSummaryCardKey
              ? activeTopic.cardKey === cardKey
              : isActive;
            const cardYouTubeLink = youTubeLinkByKey.get(cardKey) || null;
            const isPreviewActive = previewCardKey === cardKey;
            return (
              <SummaryCard
                key={cardKey}
                card={card}
                cardKey={cardKey}
                registerSummaryCardRef={cardRegistry.register}
                isCardActive={isCardActive}
                isPreviewActive={isPreviewActive}
                cardYouTubeLink={cardYouTubeLink}
                onCardEnter={showPreviewForCard}
                onCardLeave={handleSummaryCardLeave}
                onCardClick={handleCardClick}
                onCardKeyDown={handleSummaryCardKeyDown}
                onShowSourceSentences={onShowSource}
                enterDelay={getCardEnterDelay(index, cards.length)}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

export default React.memo(CanvasSummaryView);
