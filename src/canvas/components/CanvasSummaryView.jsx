import React from 'react';
import { getYouTubeTimestampLink, getYouTubeVideoId } from '../../utils/youtubeTimestamp.js';
import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';
import useSummaryPreview from '../hooks/useSummaryPreview.js';
import SummarySourcePreview from './SummarySourcePreview.jsx';

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
            <div className="canvas-summary-view__summary-tooltip" role="tooltip">
              {canShowSourceSentences && (
                <button
                  type="button"
                  className="canvas-summary-view__summary-tooltip-button"
                  onMouseDown={(event) => event.stopPropagation()}
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
  // Resolving a YouTube deep-link scans the sentence array; doing it per card
  // inside the render map re-ran it for every card on every hover/zoom. Compute
  // the whole set once and reuse it for both the cards and the preview header.
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
          {cards.map((card) => {
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
                onCardClick={handleSummaryCardClick}
                onCardKeyDown={handleSummaryCardKeyDown}
                onShowSourceSentences={onShowSource}
              />
            );
          })}
        </div>
      </div>
    </>
  );
}

export default React.memo(CanvasSummaryView);
