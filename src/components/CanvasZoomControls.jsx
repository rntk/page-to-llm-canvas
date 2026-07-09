import React, { useState } from 'react';
import TopicLevelSwitcher from './TopicLevelSwitcher.jsx';

/**
 * Floating zoom & view-mode controls for the canvas, mirroring the main app.
 *
 * @param {{
 *   onNavigate: (pos: "top" | "bottom" | "prev" | "next" | "first-topic" | "prev-topic" | "next-topic" | "last-topic") => void,
 *   onZoomIn: () => void,
 *   onZoomOut: () => void,
 *   onReset: () => void,
 *   showSummaryMode: boolean,
 *   onToggleSummaryMode: () => void,
 *   summaryModeAvailable?: boolean,
 *   showTopicHierarchy: boolean,
 *   onToggleTopicHierarchy: () => void,
 *   onClose: () => void,
 *   selectedLevel: number,
 *   maxLevel: number,
 *   onLevelChange: (level: number) => void,
 * }} props
 * @returns {import("react").JSX.Element}
 */
function CanvasZoomControls({
  onNavigate,
  onZoomIn,
  onZoomOut,
  onReset,
  showSummaryMode,
  onToggleSummaryMode,
  summaryModeAvailable = true,
  showTopicHierarchy,
  onToggleTopicHierarchy,
  onClose,
  selectedLevel,
  maxLevel,
  onLevelChange,
}) {
  const [isFolded, setIsFolded] = useState(false);
  const [isHorizontal, setIsHorizontal] = useState(false);

  return (
    <div
      className={`canvas-controls${isFolded ? ' is-folded' : ''}${isHorizontal ? ' is-horizontal' : ''}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="canvas-controls-header">
        <button
          type="button"
          className="canvas-zoom-btn"
          onClick={() => setIsFolded((v) => !v)}
          title={isFolded ? 'Expand controls' : 'Collapse controls'}
        >
          {isFolded ? '⊞' : '⊟'}
        </button>
        <button
          type="button"
          className="canvas-zoom-btn"
          onClick={() => setIsHorizontal((v) => !v)}
          title={isHorizontal ? 'Switch to vertical' : 'Switch to horizontal'}
        >
          {isHorizontal ? '⬍' : '⬌'}
        </button>
        <button
          type="button"
          className="canvas-zoom-btn canvas-close-btn"
          onClick={onClose}
          aria-label="Close"
          title="Close canvas"
        >
          ×
        </button>
      </div>
      {!isFolded && (
        <div className="canvas-controls-body">
          <div className="canvas-navigation-grid">
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('first-topic')}
              title="First topic"
            >
              ⇞
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('top')}
              title="Scroll to top"
            >
              ⇈
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('prev-topic')}
              title="Previous topic"
            >
              ▲
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('prev')}
              title="Previous page"
            >
              ↑
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('next-topic')}
              title="Next topic"
            >
              ▼
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('next')}
              title="Next page"
            >
              ↓
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('last-topic')}
              title="Last topic"
            >
              ⇟
            </button>
            <button
              type="button"
              className="canvas-zoom-btn"
              onClick={() => onNavigate('bottom')}
              title="Scroll to bottom"
            >
              ⇊
            </button>
          </div>
          <div className="canvas-spacer" />
          <button type="button" className="canvas-zoom-btn" onClick={onZoomIn} title="Zoom in">
            +
          </button>
          <button type="button" className="canvas-zoom-btn" onClick={onZoomOut} title="Zoom out">
            −
          </button>
          <button type="button" className="canvas-zoom-btn" onClick={onReset} title="Reset zoom">
            ⊙
          </button>
          <div className="canvas-spacer" />
          {summaryModeAvailable && (
            <button
              type="button"
              className={`canvas-read-toggle${showSummaryMode ? ' is-active' : ''}`}
              onClick={onToggleSummaryMode}
              title={showSummaryMode ? 'Show article text' : 'Show summary view (per topic level)'}
            >
              S
            </button>
          )}
          <div className="canvas-control-hierarchy-group">
            {(showTopicHierarchy || showSummaryMode) && (
              <TopicLevelSwitcher
                selectedLevel={selectedLevel}
                maxLevel={maxLevel}
                onChange={onLevelChange}
                label=""
              />
            )}
            <button
              type="button"
              className={`canvas-read-toggle${showTopicHierarchy ? ' is-active' : ''}`}
              onClick={onToggleTopicHierarchy}
              title={showTopicHierarchy ? 'Hide topic hierarchy' : 'Show topic hierarchy'}
            >
              H
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default React.memo(CanvasZoomControls);
