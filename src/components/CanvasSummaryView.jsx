import React from "react";

export default function CanvasSummaryView({
  summaryViewCards,
  summaryViewActivePath,
  summaryCardRefs,
  setHoveredTopicKey,
  articleTextRef,
  onShowSourceSentences,
}) {
  if (summaryViewCards.length === 0) {
    return (
      <div className="canvas-summary-view" ref={articleTextRef}>
        <p className="canvas-summary-view__empty">
          No summaries available at this level.
        </p>
      </div>
    );
  }

  return (
    <div className="canvas-summary-view" ref={articleTextRef}>
      <div className="canvas-summary-view__cards">
        {summaryViewCards.map((card) => {
          const isActive = summaryViewActivePath === card.path;
          const hasSummaryContent = Boolean(card.text);
          const canShowSourceSentences = card.sourceSentences.length > 0;
          return (
            <article
              key={card.key || card.path}
              ref={(el) => {
                if (el) summaryCardRefs.current[card.key || card.path] = el;
                else delete summaryCardRefs.current[card.key || card.path];
              }}
              className={`canvas-summary-view__card${isActive ? " is-active" : ""}`}
              onMouseEnter={() => setHoveredTopicKey(card.path)}
              onMouseLeave={() =>
                setHoveredTopicKey((current) =>
                  current === card.path ? null : current,
                )
              }
              title={card.path}
            >
              <header className="canvas-summary-view__card-header">
                <span className="canvas-summary-view__card-path">
                  {card.path}
                </span>
                {card.sourceSentences.length > 0 && (
                  <span className="canvas-summary-view__card-meta">
                    sentences {card.startSentence} (
                    {card.sourceSentences.length})
                  </span>
                )}
              </header>
              {hasSummaryContent && (
                <div className="canvas-summary-view__summary-tooltip-wrap">
                  {card.text && (
                    <p className="canvas-summary-view__card-text">
                      {card.text}
                    </p>
                  )}
                  {canShowSourceSentences && (
                    <div
                      className="canvas-summary-view__summary-tooltip"
                      role="tooltip"
                    >
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
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
