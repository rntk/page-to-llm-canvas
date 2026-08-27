import YouTubeTimestampButton from '../../components/YouTubeTimestampButton.jsx';

/**
 * Floating panel that renders the original article text behind a summary card,
 * with the card's own sentences highlighted.
 *
 * Purely presentational: positioning, HTML building and hover intent all live in
 * `useSummaryPreview`. The two refs are passed as ordinary props because the
 * hook's measure effect observes the outer element alongside the summary list.
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
      onMouseDown={(event) => event.stopPropagation()}
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

export default SummarySourcePreview;
