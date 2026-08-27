import React, { useState } from 'react';
import TopicLevelSwitcher from '../../components/TopicLevelSwitcher.jsx';

const NAV_BUTTONS = [
  { pos: 'first-topic', title: 'First topic', glyph: '⇞' },
  { pos: 'top', title: 'Scroll to top', glyph: '⇈' },
  { pos: 'prev-topic', title: 'Previous topic', glyph: '▲' },
  { pos: 'prev', title: 'Previous page', glyph: '↑' },
  { pos: 'next-topic', title: 'Next topic', glyph: '▼' },
  { pos: 'next', title: 'Next page', glyph: '↓' },
  { pos: 'last-topic', title: 'Last topic', glyph: '⇟' },
  { pos: 'bottom', title: 'Scroll to bottom', glyph: '⇊' },
];

/**
 * Grid of scroll/topic navigation buttons.
 *
 * @param {object} props
 * @param {function(string): void} props.onNavigate pos: "top" | "bottom" | "prev" | "next" | "first-topic" | "prev-topic" | "next-topic" | "last-topic"
 * @returns {JSX.Element}
 */
function CanvasNavigationPad({ onNavigate }) {
  return (
    <div className="canvas-navigation-grid">
      {NAV_BUTTONS.map(({ pos, title, glyph }) => (
        <button
          key={pos}
          type="button"
          className="canvas-zoom-btn"
          onClick={() => onNavigate(pos)}
          title={title}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}

/**
 * Zoom in/out/reset buttons.
 *
 * @param {object} props
 * @param {function(): void} props.onZoomIn
 * @param {function(): void} props.onZoomOut
 * @param {function(): void} props.onReset
 * @returns {JSX.Element}
 */
function CanvasZoomButtons({ onZoomIn, onZoomOut, onReset }) {
  return (
    <>
      <button type="button" className="canvas-zoom-btn" onClick={onZoomIn} title="Zoom in">
        +
      </button>
      <button type="button" className="canvas-zoom-btn" onClick={onZoomOut} title="Zoom out">
        −
      </button>
      <button type="button" className="canvas-zoom-btn" onClick={onReset} title="Reset zoom">
        ⊙
      </button>
    </>
  );
}

/**
 * Chat and summary-mode view toggles.
 *
 * @param {object} props
 * @param {boolean} [props.showChat]
 * @param {function(): void} [props.onToggleChat]
 * @param {boolean} props.showSummaryMode
 * @param {function(): void} props.onToggleSummaryMode
 * @param {boolean} [props.summaryModeAvailable]
 * @returns {JSX.Element}
 */
function CanvasViewControls({
  showChat,
  onToggleChat,
  showSummaryMode,
  onToggleSummaryMode,
  summaryModeAvailable,
}) {
  return (
    <>
      <button
        type="button"
        className={`canvas-chat-toggle${showChat ? ' is-active' : ''}`}
        onClick={onToggleChat}
        title={showChat ? 'Hide article chat' : 'Chat with the article'}
        aria-pressed={showChat}
      >
        C
      </button>
      {summaryModeAvailable && (
        <button
          type="button"
          className={`canvas-view-toggle${showSummaryMode ? ' is-active' : ''}`}
          onClick={onToggleSummaryMode}
          title={showSummaryMode ? 'Show article text' : 'Show summary view (per topic level)'}
        >
          S
        </button>
      )}
    </>
  );
}

/**
 * Topic-level switcher plus the hierarchy visibility toggle.
 *
 * @param {object} props
 * @param {boolean} props.showTopicHierarchy
 * @param {function(): void} props.onToggleTopicHierarchy
 * @param {boolean} props.showSummaryMode
 * @param {number} props.selectedLevel
 * @param {number} props.maxLevel
 * @param {function(number): void} props.onLevelChange
 * @returns {JSX.Element}
 */
function CanvasLevelControl({
  showTopicHierarchy,
  onToggleTopicHierarchy,
  showSummaryMode,
  selectedLevel,
  maxLevel,
  onLevelChange,
}) {
  return (
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
        className={`canvas-view-toggle${showTopicHierarchy ? ' is-active' : ''}`}
        onClick={onToggleTopicHierarchy}
        title={showTopicHierarchy ? 'Hide topic hierarchy' : 'Show topic hierarchy'}
      >
        H
      </button>
    </div>
  );
}

/**
 * Floating toolbar for the canvas: navigation, zoom, and view-mode controls,
 * mirroring the main app.
 *
 * @param {object} props
 * @param {function(string): void} props.onNavigate pos: "top" | "bottom" | "prev" | "next" | "first-topic" | "prev-topic" | "next-topic" | "last-topic"
 * @param {function(): void} props.onZoomIn
 * @param {function(): void} props.onZoomOut
 * @param {function(): void} props.onReset
 * @param {boolean} props.showSummaryMode
 * @param {function(): void} props.onToggleSummaryMode
 * @param {boolean} [props.summaryModeAvailable]
 * @param {boolean} props.showTopicHierarchy
 * @param {function(): void} props.onToggleTopicHierarchy
 * @param {function(): void} props.onClose
 * @param {number} props.selectedLevel
 * @param {number} props.maxLevel
 * @param {function(number): void} props.onLevelChange
 * @param {boolean} [props.showChat]
 * @param {function(): void} [props.onToggleChat]
 * @returns {JSX.Element}
 */
function CanvasToolbar({
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
  showChat = false,
  onToggleChat,
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
          <CanvasNavigationPad onNavigate={onNavigate} />
          <div className="canvas-spacer" />
          <CanvasZoomButtons onZoomIn={onZoomIn} onZoomOut={onZoomOut} onReset={onReset} />
          <div className="canvas-spacer" />
          <CanvasViewControls
            showChat={showChat}
            onToggleChat={onToggleChat}
            showSummaryMode={showSummaryMode}
            onToggleSummaryMode={onToggleSummaryMode}
            summaryModeAvailable={summaryModeAvailable}
          />
          <CanvasLevelControl
            showTopicHierarchy={showTopicHierarchy}
            onToggleTopicHierarchy={onToggleTopicHierarchy}
            showSummaryMode={showSummaryMode}
            selectedLevel={selectedLevel}
            maxLevel={maxLevel}
            onLevelChange={onLevelChange}
          />
        </div>
      )}
    </div>
  );
}

export default React.memo(CanvasToolbar);
