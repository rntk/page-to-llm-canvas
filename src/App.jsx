import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecord } from './useRecord.js';
import { MSG } from '../messages.js';
import {
  buildTopicCards,
  getTopicTitleFontSize,
  getZoomAdjustedCardWidth,
  getZoomAdjustedSummaryCardWidth,
  patchTopicCardsFromSummaryMetrics,
  COLUMN_GAP,
  RAIL_PADDING,
} from './topicCards.js';
import CanvasTopicHierarchyRail from './components/CanvasTopicHierarchyRail.jsx';
import CanvasSummaryView from './components/CanvasSummaryView.jsx';
import CanvasZoomControls from './components/CanvasZoomControls.jsx';
import SpinnerOverlay from './components/SpinnerOverlay.jsx';
import SummaryErrorsOverlay from './components/SummaryErrorsOverlay.jsx';
import ArticleHtml from './components/ArticleHtml.jsx';
import { closeModal } from './closeModal.js';
import { useCanvasTransform } from './useCanvasTransform.js';
import { clampScale } from './utils/canvasMath.js';
import { useCanvasAlignment } from './useCanvasAlignment.js';
import { useSentenceMetrics } from './useSentenceMetrics.js';
import { useSentenceHighlights } from './useSentenceHighlights.js';
import { useInitialView } from './useInitialView.js';
import { useCanvasRecordViewModel } from './useCanvasRecordViewModel.js';
import { useCanvasTopicNavigation } from './useCanvasTopicNavigation.js';
import { useTopicSelection } from './useTopicSelection.js';
import { retryRecord, resolveSummaryErrors } from './utils/errorUtils.js';
import { selectCurrentTopicSummary } from './utils/currentTopicSummary.js';
import ArticleChat from './chat/ArticleChat.jsx';
import { useChatHighlights } from './chat/useChatHighlights.js';
import { buildSentenceDomRange } from './sentenceHighlight.js';

/**
 * @param {{ initialKey: string }} props
 * @returns {import("react").JSX.Element}
 */
export default function App({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [showSummaryModeRaw, setShowSummaryMode] = useState(false);
  const [showTopicHierarchy, setShowTopicHierarchy] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [chatSentenceNumbers, setChatSentenceNumbers] = useState([]);
  const {
    selectedTopicKey,
    selectedTopicCardKey,
    hoveredTopicKey,
    hoveredTopicCardKey,
    selectedLevel,
    activeTopicKey,
    activeTopicCardKey,
    setSelectedTopicKey,
    setSelectedTopicCardKey,
    setHoveredTopicKey,
    setHoveredTopicCardKey,
    setSelectedLevel,
    handleTopicEnter,
    handleTopicLeave,
    toggleTopicSelection,
    clearTopicSelection,
  } = useTopicSelection();

  const articleTextRef = useRef(null);
  const summaryWrapRef = useRef(null);
  const summaryCardRefs = useRef({});
  const pendingChatHighlightLineRef = useRef(null);

  const {
    scale,
    isCanvasDragging,
    isFocusingHighlight,
    isZoomingToTarget,
    canvasWrapRef,
    canvasViewportRef,
    canvasWrapElRef,
    scaleRef,
    translateRef,
    userMovedCanvasRef,
    handleMouseDown,
    setTransformNow,
    navigateCanvas,
    zoomToTarget,
    flashFocus,
  } = useCanvasTransform({ contentRef: articleTextRef });

  const handleCanvasMouseDown = useCallback(
    (e) => {
      // preventDefault inside handleMouseDown suppresses native focus,
      // so re-focus the wrap explicitly to keep keyboard shortcuts alive.
      const wrap = canvasWrapElRef.current;
      if (wrap && typeof wrap.focus === 'function') {
        wrap.focus({ preventScroll: true });
      }
      try {
        window.focus();
      } catch (_) {
        /* noop */
      }
      handleMouseDown(e);
    },
    [handleMouseDown, canvasWrapElRef],
  );

  const {
    topics,
    topicSentenceIndex,
    sentences,
    articleHtml,
    maxLevel,
    allSummaryCards,
    summaryCards,
    isDone,
    summariesDisabled,
    showSummaryMode,
    isNeedsAttention,
    isRecordError,
    isMissing,
    isDeleted,
    stage,
  } = useCanvasRecordViewModel({ record, error, selectedLevel, showSummaryModeRaw });

  // Measurement engine: live sentence Ranges plus measured sentence/summary
  // geometry that drives the topic-hierarchy rail. `summaryMetricsState` holds
  // topic-card positions in summary mode, derived from the rendered summary
  // cards' bounding rects; `refreshSentenceRanges` is shared with the highlight
  // hook and the zoom-to-sentence handlers below.
  const { sentenceMetrics, summaryMetricsState, refreshSentenceRanges } = useSentenceMetrics({
    articleTextRef,
    summaryWrapRef,
    summaryCardRefs,
    scaleRef,
    isDone,
    showSummaryMode,
    isZoomingToTarget,
    sentences,
    summaryCards,
    articleHtml,
  });

  const topicCards = useMemo(() => {
    if (showSummaryMode) {
      // Build cards using synthesized "sentence" indices: each summary card path
      // gets a unique pseudo-sentence number, and the sentenceMetrics map uses
      // those numbers. To keep things simple, we instead patch positions
      // post-build using a path -> {top, height} map derived from measured
      // summary-card bounding rects.
      const cards = buildTopicCards(topics, selectedLevel, new Map());
      return patchTopicCardsFromSummaryMetrics(cards, allSummaryCards, summaryMetricsState);
    }
    return buildTopicCards(topics, selectedLevel, sentenceMetrics);
  }, [
    topics,
    selectedLevel,
    sentenceMetrics,
    showSummaryMode,
    summaryMetricsState,
    allSummaryCards,
  ]);

  const cardWidth = useMemo(() => getZoomAdjustedCardWidth(scale), [scale]);
  const currentSummaryWidth = useMemo(() => getZoomAdjustedSummaryCardWidth(scale), [scale]);

  const railWidth = useMemo(
    () => (selectedLevel + 1) * cardWidth + selectedLevel * COLUMN_GAP + RAIL_PADDING * 2,
    [selectedLevel, cardWidth],
  );

  // Only `titleFontSize` and `right` are zoom-dependent here; `top`/`height` come
  // straight from the (scale-independent) sentence layout. The rail relies on
  // that: it memoizes its heavy collision pass on the stable geometry and only
  // re-applies these two fields on zoom.
  const zoomAdjustedTopicCards = useMemo(
    () =>
      topicCards.map((card) => ({
        ...card,
        titleFontSize: getTopicTitleFontSize({ scale, height: card.height }),
        right: RAIL_PADDING + card.levelIndex * (cardWidth + COLUMN_GAP),
      })),
    [scale, cardWidth, topicCards],
  );

  // Unified canvas alignment: keeps the reading column steady across mode/level
  // changes (no jump) and only gently re-centers it when it drifts out of the
  // comfort dead-zone. `captureAnchor()` is called by the toggle handlers below
  // *before* they change state so the post-change pan can preserve the column's
  // on-screen position. The reading column (articleTextRef) is the anchor in
  // both modes; the rail and side cards are allowed to reflow around it.
  const { captureAnchor, skipNextAlignment } = useCanvasAlignment({
    enabled: isDone,
    anchorRef: articleTextRef,
    wrapElRef: canvasWrapElRef,
    setTransformNow,
    translateRef,
    scaleRef,
    flashFocus,
    deps: [showSummaryMode, selectedLevel, showTopicHierarchy],
  });

  // The single summary card shown to the left of the article for whichever topic
  // is currently hovered or selected in the rail. Suppressed in summary mode,
  // where every summary is already shown in the center column.
  const currentTopicSummary = useMemo(() => {
    if (summariesDisabled) return null;
    return selectCurrentTopicSummary({
      showSummaryMode,
      activeTopicKey,
      activeTopicCardKey,
      allSummaryCards,
    });
  }, [summariesDisabled, showSummaryMode, activeTopicKey, activeTopicCardKey, allSummaryCards]);

  // Paint the selected/hovered topic's source sentences via the native CSS
  // Custom Highlight API; shares the measurement engine's live sentence Ranges.
  useSentenceHighlights({
    isDone,
    showSummaryMode,
    topicSentenceIndex,
    selectedTopicKey,
    hoveredTopicKey,
    articleHtml,
    refreshSentenceRanges,
  });

  useChatHighlights({
    isDone,
    showSummaryMode,
    sentenceNumbers: chatSentenceNumbers,
    articleHtml,
    refreshSentenceRanges,
  });

  const handleChatHighlight = useCallback(({ startLine, endLine }, { focus = false } = {}) => {
    if (focus) pendingChatHighlightLineRef.current ??= startLine;
    setShowSummaryMode(false);
    setChatSentenceNumbers((current) => {
      const next = new Set(current);
      for (let line = startLine; line <= endLine; line += 1) next.add(line);
      return Array.from(next).sort((a, b) => a - b);
    });
  }, []);
  const handleClearChatHighlights = useCallback(() => setChatSentenceNumbers([]), []);

  useEffect(() => {
    if (showSummaryMode || pendingChatHighlightLineRef.current === null) return;
    const sentenceNumber = pendingChatHighlightLineRef.current;
    pendingChatHighlightLineRef.current = null;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    const range = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
    if (range) zoomToTarget(range.getBoundingClientRect());
  }, [chatSentenceNumbers, refreshSentenceRanges, showSummaryMode, zoomToTarget]);

  // ── Topic interaction ────────────────────────────────────────────────────

  const { zoomToTopic, panToTopic, handleNavigate, handleShowSourceSentences } =
    useCanvasTopicNavigation({
      showSummaryMode,
      setShowSummaryMode,
      summaryCardRefs,
      summaryCards,
      summaryMetricsState,
      zoomAdjustedTopicCards,
      selectedLevel,
      selectedTopicKey,
      selectedTopicCardKey,
      setSelectedTopicKey,
      setSelectedTopicCardKey,
      refreshSentenceRanges,
      zoomToTarget,
      canvasWrapElRef,
      scaleRef,
      translateRef,
      setTransformNow,
      flashFocus,
      navigateCanvas,
      skipNextAlignment,
    });

  const handleTopicClick = useCallback(
    (topicKey, card) => {
      toggleTopicSelection(topicKey, card);
      zoomToTopic(topicKey, card);
    },
    [toggleTopicSelection, zoomToTopic],
  );

  // ── Focus & Keyboard Shortcuts ──────────────────────────────────────────
  // The modal runs inside an iframe. Keyboard listeners on the iframe's
  // window only fire when the iframe itself has focus, so pull focus in as
  // soon as the canvas mounts and whenever the user clicks inside it.
  useEffect(() => {
    try {
      window.focus();
    } catch (_) {
      /* noop */
    }
  }, []);

  useEffect(() => {
    if (!isDone) return;
    const wrap = canvasWrapElRef.current;
    if (wrap && typeof wrap.focus === 'function') {
      wrap.focus({ preventScroll: true });
    }
  }, [isDone, canvasWrapElRef]);

  // ── Pipeline lifecycle ───────────────────────────────────────────────────
  // The modal does NOT start the pipeline. It only asks the background to
  // ensure a pipeline is running for this key, then renders whatever state
  // arrives through chrome.storage.onChanged.

  useEffect(() => {
    if (!initialKey) return;
    chrome.runtime.sendMessage({ type: MSG.ensurePipeline, key: initialKey }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('PageToLLM Canvas ensurePipeline error:', chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        console.warn('PageToLLM Canvas ensurePipeline failed:', resp.error);
      }
    });
  }, [initialKey]);

  const handleRetry = useCallback(() => {
    if (!initialKey) return;
    retryRecord(initialKey, 'Canvas').catch(() => {});
  }, [initialKey]);

  const handleSummaryErrorsRetry = useCallback(
    () => resolveSummaryErrors(initialKey, 'retry', 'Canvas'),
    [initialKey],
  );
  const handleSummaryErrorsSkip = useCallback(
    () => resolveSummaryErrors(initialKey, 'skip', 'Canvas'),
    [initialKey],
  );

  const handleZoomIn = useCallback(() => {
    userMovedCanvasRef.current = true;
    setTransformNow(clampScale((scaleRef.current || 1) * 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef, userMovedCanvasRef]);

  const handleZoomOut = useCallback(() => {
    userMovedCanvasRef.current = true;
    setTransformNow(clampScale((scaleRef.current || 1) / 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef, userMovedCanvasRef]);

  const handleReset = useCallback(() => {
    userMovedCanvasRef.current = true;
    setTransformNow(1, { x: 40, y: 40 });
  }, [setTransformNow, userMovedCanvasRef]);

  const handleToggleSummaryMode = useCallback(() => {
    // No summaries to show a-la-carte when the pipeline skipped them.
    if (summariesDisabled) return;
    // Content swaps wholesale (article ⇄ summary cards), so reset the vertical
    // position to the top margin; horizontal stays continuous.
    captureAnchor(true);
    setShowSummaryMode((v) => !v);
  }, [captureAnchor, summariesDisabled]);

  const handleToggleTopicHierarchy = useCallback(() => {
    // Same content, only the rail's reserved width changes — preserve both axes.
    captureAnchor(false);
    setShowTopicHierarchy((v) => !v);
  }, [captureAnchor]);

  const handleLevelChange = useCallback(
    (level) => {
      // Clicking the already-selected level is a no-op; skip so we never strand
      // a captured anchor that the next real switch would then mis-consume.
      if (level === selectedLevel) return;
      // Same content, denser/sparser rail — preserve both axes.
      captureAnchor(false);
      setSelectedLevel(level);
      clearTopicSelection();
    },
    [captureAnchor, clearTopicSelection, selectedLevel, setSelectedLevel],
  );

  // Canvas alignment (centering + anti-jump continuity) is owned by
  // useCanvasAlignment above.

  // ── Opening view: leaf level, zoomed out ~3 clicks, first topic's summary ──
  // Owned by useInitialView: a one-time three-phase state machine that runs once
  // the article and topic hierarchy are measured. See the hook for why the steps
  // are split across separate committed renders.
  useInitialView({
    isDone,
    topics,
    sentenceMetrics,
    maxLevel,
    selectedLevel,
    setSelectedLevel,
    userMovedCanvasRef,
    setTransformNow,
    scaleRef,
    translateRef,
    showSummaryMode,
    summaryCards,
    zoomAdjustedTopicCards,
    summaryMetricsState,
    panToTopic,
    setSelectedTopicKey,
    setSelectedTopicCardKey,
  });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="pagetollm-modal-root">
      <main className="pagetollm-body">
        {isNeedsAttention && (
          <SummaryErrorsOverlay
            summaryErrors={record?.summaryErrors}
            onRetry={handleSummaryErrorsRetry}
            onSkip={handleSummaryErrorsSkip}
          />
        )}
        {!isDone && !isNeedsAttention && (
          <SpinnerOverlay
            stage={stage}
            error={!isRecordError && !isMissing && !isDeleted ? error : null}
            recordError={isRecordError ? (record?.error ?? '') : undefined}
            onRetry={isRecordError ? handleRetry : undefined}
            isMissing={isMissing}
            isDeleted={isDeleted}
          />
        )}
        {isDone && (
          <div className="pagetollm-canvas-main">
            <div
              ref={canvasWrapRef}
              className={`canvas-area${isCanvasDragging ? ' is-dragging' : ''}`}
              onMouseDown={handleCanvasMouseDown}
              tabIndex={0}
            >
              <div
                ref={canvasViewportRef}
                className={`canvas-viewport${isFocusingHighlight ? ' is-focusing-highlight' : ''}`}
              >
                <div
                  ref={summaryWrapRef}
                  className={`canvas-article-with-summaries${showTopicHierarchy || showSummaryMode ? ' has-topic-hierarchy' : ''}${showSummaryMode ? ' is-summary-mode' : ''}`}
                  style={{
                    '--canvas-topic-hierarchy-width': `${railWidth}px`,
                    '--current-summary-width': `${currentSummaryWidth}px`,
                  }}
                >
                  {showSummaryMode ? (
                    <CanvasSummaryView
                      summaryViewCards={summaryCards}
                      summaryViewActivePath={activeTopicKey}
                      summaryViewActiveCardKey={activeTopicCardKey}
                      summaryViewHoveredPath={hoveredTopicKey}
                      summaryViewHoveredCardKey={hoveredTopicCardKey}
                      summaryCardRefs={summaryCardRefs}
                      setHoveredTopicKey={setHoveredTopicKey}
                      setHoveredTopicCardKey={setHoveredTopicCardKey}
                      articleTextRef={articleTextRef}
                      onShowSourceSentences={handleShowSourceSentences}
                      articleHtml={articleHtml}
                      sentences={sentences}
                      sourceUrl={record?.sourceUrl}
                      previewWidth={currentSummaryWidth}
                    />
                  ) : (
                    <ArticleHtml html={articleHtml} articleTextRef={articleTextRef} />
                  )}

                  <CanvasTopicHierarchyRail
                    show={showTopicHierarchy || showSummaryMode}
                    selectedLevel={selectedLevel}
                    topicCards={zoomAdjustedTopicCards}
                    railWidth={railWidth}
                    cardWidth={cardWidth}
                    activeTopicKey={activeTopicKey}
                    activeTopicCardKey={activeTopicCardKey}
                    selectedTopicKey={selectedTopicKey}
                    selectedTopicCardKey={selectedTopicCardKey}
                    onTopicEnter={handleTopicEnter}
                    onTopicLeave={handleTopicLeave}
                    onTopicClick={handleTopicClick}
                    onCancelTopicSelection={clearTopicSelection}
                    readTopics={null}
                    onToggleRead={null}
                    currentTopicSummary={currentTopicSummary}
                    sentences={sentences}
                    sourceUrl={record?.sourceUrl}
                  />
                </div>
              </div>
            </div>

            <CanvasZoomControls
              onClose={closeModal}
              onNavigate={handleNavigate}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onReset={handleReset}
              showSummaryMode={showSummaryMode}
              onToggleSummaryMode={handleToggleSummaryMode}
              summaryModeAvailable={!summariesDisabled}
              showTopicHierarchy={showTopicHierarchy}
              onToggleTopicHierarchy={handleToggleTopicHierarchy}
              selectedLevel={selectedLevel}
              maxLevel={maxLevel}
              onLevelChange={handleLevelChange}
              showChat={showChat}
              onToggleChat={() => setShowChat((value) => !value)}
            />
            {showChat ? (
              <div className="canvas-chat-panel">
                <ArticleChat
                  recordKey={initialKey}
                  sentences={sentences}
                  onHighlight={handleChatHighlight}
                  onClearHighlights={handleClearChatHighlights}
                  onClose={() => setShowChat(false)}
                />
              </div>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
