import React, { Activity, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecord } from './hooks/useRecord.js';
import {
  buildTopicCards,
  getTopicTitleFontSize,
  getZoomAdjustedTitleFontSize,
  getZoomAdjustedCardWidth,
  getZoomAdjustedSummaryCardWidth,
  patchTopicCardsFromSummaryMetrics,
  COLUMN_GAP,
  RAIL_PADDING,
} from '../domain/topicCards.js';
import CanvasTopicHierarchyRail from './components/CanvasTopicHierarchyRail.jsx';
import CanvasSummaryView from './components/CanvasSummaryView.jsx';
import CanvasToolbar from './components/CanvasToolbar.jsx';
import CanvasStartupOverlay from './components/CanvasStartupOverlay.jsx';
import ArticleHtml from './components/ArticleHtml.jsx';
import { useCanvasTransform } from './hooks/useCanvasTransform.js';
import { clampScale } from '../utils/canvasMath.js';
import { useCanvasAlignment } from './hooks/useCanvasAlignment.js';
import { useSentenceMetrics } from './hooks/useSentenceMetrics.js';
import { useSentenceHighlights } from './hooks/useSentenceHighlights.js';
import { useInitialView } from './hooks/useInitialView.js';
import { useCanvasRecordViewModel } from './hooks/useCanvasRecordViewModel.js';
import { useCanvasStartup } from './hooks/useCanvasStartup.js';
import { useCanvasTopicNavigation } from './hooks/useCanvasTopicNavigation.js';
import { useSummaryCardRegistry } from './hooks/useSummaryCardRegistry.js';
import { useTopicSelection } from './hooks/useTopicSelection.js';
import { selectCurrentTopicSummary } from '../domain/currentTopicSummary.js';
import { getSummaryFontSizes } from '../utils/denseCardLayout.js';
import ArticleChat from '../chat/ArticleChat.jsx';
import { useChatHighlights } from '../chat/useChatHighlights.js';
import { buildSentenceDomRange } from '../highlights/sentenceHighlight.js';
import { PIPELINE_STATUS } from '../shared/runtime/contracts.js';

const noop = () => {};

/**
 * @param {{ initialKey: string, recordSource: object, onClose?: Function }} props
 * @returns {JSX.Element}
 */
export default function App({ initialKey, recordSource, onClose = noop }) {
  const { record } = useRecord(initialKey, recordSource);

  // Canvas is a read-only view of completed data. Pipeline progress, failures,
  // retries, and summary review are handled from the popup and Options page.
  if (record?.status !== PIPELINE_STATUS.DONE) return null;

  return <CanvasApp initialKey={initialKey} record={record} onClose={onClose} />;
}

function CanvasApp({ initialKey, record, onClose }) {
  const [showSummaryModeRaw, setShowSummaryMode] = useState(false);
  const [showTopicHierarchy, setShowTopicHierarchy] = useState(true);
  const [showChat, setShowChat] = useState(false);
  const [chatSentenceNumbers, setChatSentenceNumbers] = useState([]);
  const {
    selectedTarget,
    hoveredTarget,
    activeTarget,
    selectedLevel,
    setSelectedLevel,
    enterTopic,
    leaveTopic,
    toggleTopic,
    selectTopic,
    clearSelection,
  } = useTopicSelection();

  const articleTextRef = useRef(null);
  const summaryWrapRef = useRef(null);
  const summaryCardRegistry = useSummaryCardRegistry();
  const pendingChatHighlightLineRef = useRef(null);

  const applyVisualCardScale = useCallback(
    (visualScale) => {
      const group = summaryWrapRef.current;
      if (!group) return;
      const visualCardWidth = getZoomAdjustedCardWidth(visualScale);
      const visualSummaryWidth = getZoomAdjustedSummaryCardWidth(visualScale);
      const visualRailWidth =
        (selectedLevel + 1) * visualCardWidth + selectedLevel * COLUMN_GAP + RAIL_PADDING * 2;
      const visualTitleSize = getZoomAdjustedTitleFontSize(visualScale);

      group.classList.toggle('is-live-zoomed-out', visualScale < 1);

      group.style.setProperty('--topic-card-width', `${visualCardWidth}px`);
      group.style.setProperty('--current-summary-width', `${visualSummaryWidth}px`);
      group.style.setProperty('--canvas-topic-hierarchy-width', `${visualRailWidth}px`);
      group.style.setProperty('--canvas-zoom-title-font-size', `${visualTitleSize}px`);
      group.style.setProperty(
        '--canvas-zoom-youtube-font-size',
        `${getSummaryFontSizes({ titleFontSize: visualTitleSize }).youtube}px`,
      );
      for (let level = 0; level <= selectedLevel; level += 1) {
        group.style.setProperty(
          `--topic-card-level-${level}-right`,
          `${RAIL_PADDING + level * (visualCardWidth + COLUMN_GAP)}px`,
        );
      }

      // The floating summary follows the active rail card's height cap, just as
      // the React-derived settled layout does, but now on every visual frame.
      const summaryAnchor = group.querySelector(
        '.canvas-topic-hierarchy__card.is-selected, .canvas-topic-hierarchy__card.is-active',
      );
      const titleCap = Number.parseFloat(
        summaryAnchor?.style.getPropertyValue('--topic-card-title-max-font-size'),
      );
      const summaryFontSizes = getSummaryFontSizes({
        titleFontSize: Number.isFinite(titleCap)
          ? Math.min(visualTitleSize, titleCap)
          : visualTitleSize,
      });
      group.style.setProperty('--current-summary-kicker-font-size', `${summaryFontSizes.kicker}px`);
      group.style.setProperty('--current-summary-title-font-size', `${summaryFontSizes.title}px`);
      group.style.setProperty('--current-summary-text-font-size', `${summaryFontSizes.text}px`);
      group.style.setProperty(
        '--current-summary-youtube-font-size',
        `${summaryFontSizes.youtube}px`,
      );
      const currentSummary = group.querySelector('.canvas-topic-current-summary');
      currentSummary?.style.setProperty(
        '--current-summary-kicker-font-size',
        `${summaryFontSizes.kicker}px`,
      );
      currentSummary?.style.setProperty(
        '--current-summary-title-font-size',
        `${summaryFontSizes.title}px`,
      );
      currentSummary?.style.setProperty(
        '--current-summary-text-font-size',
        `${summaryFontSizes.text}px`,
      );
      currentSummary?.style.setProperty(
        '--current-summary-youtube-font-size',
        `${summaryFontSizes.youtube}px`,
      );
    },
    [selectedLevel],
  );

  const {
    scale,
    isCanvasDragging,
    isPanSmoothing,
    isFocusingHighlight,
    isCardZoomSmoothing,
    isZoomingToTarget,
    canvasWrapRef,
    canvasViewportRef,
    handleMouseDown,
    navigateCanvas,
    flashFocus,
    // Single imperative handle (live transform refs + setTransformNow/
    // zoomToTarget) handed to the hooks that move the canvas; stable identity,
    // so it is safe as a lone effect dependency.
    viewport,
  } = useCanvasTransform({
    contentRef: articleTextRef,
    onVisualScaleChange: applyVisualCardScale,
  });
  // The handle travels whole to the hooks below; App's own reads of the live
  // transform pull the ref containers out here because the React Compiler only
  // recognises a ref as a ref when it is destructured off the hook result
  // (reading `viewport.someRef.current` in a callback trips its immutability /
  // memoization checks). They are stable for the component's lifetime either way.
  const { canvasWrapElRef, scaleRef, userMovedCanvasRef } = viewport;

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
    summariesDisabled,
    showSummaryMode,
  } = useCanvasRecordViewModel({ record, selectedLevel, showSummaryModeRaw });

  const { sentenceMetrics, summaryMetricsState, refreshSentenceRanges, hasSettledLayout } =
    useSentenceMetrics({
      articleTextRef,
      summaryWrapRef,
      summaryCardRegistry,
      // Measurement only reads the live scale — handing it the whole viewport
      // handle would widen its surface for nothing.
      scaleRef,
      showSummaryMode,
      isZoomingToTarget,
      sentences,
      summaryCards,
      articleHtml,
    });

  const sourceDocument = useMemo(
    () => ({ html: articleHtml, sentences, sourceUrl: record?.sourceUrl }),
    [articleHtml, sentences, record?.sourceUrl],
  );

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

  const cardWidth = getZoomAdjustedCardWidth(scale);
  const currentSummaryWidth = getZoomAdjustedSummaryCardWidth(scale);
  const railWidth = (selectedLevel + 1) * cardWidth + selectedLevel * COLUMN_GAP + RAIL_PADDING * 2;

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
    anchorRef: articleTextRef,
    viewport,
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
      activeTopic: activeTarget,
      allSummaryCards,
    });
  }, [summariesDisabled, showSummaryMode, activeTarget, allSummaryCards]);

  useSentenceHighlights({
    showSummaryMode,
    topicSentenceIndex,
    selectedTopicKey: selectedTarget?.path ?? null,
    hoveredTopicKey: hoveredTarget?.path ?? null,
    articleHtml,
    refreshSentenceRanges,
  });

  useChatHighlights({
    showSummaryMode,
    sentenceNumbers: chatSentenceNumbers,
    articleHtml,
    refreshSentenceRanges,
  });

  const handleChatHighlight = useCallback(
    ({ startLine, endLine }, { focus = false } = {}) => {
      if (focus) pendingChatHighlightLineRef.current ??= startLine;
      // Leaving summary mode reflows the canvas, which would make the alignment
      // hook glide the column one frame later — on top of the zoom below, whose
      // placement then reads as "off". The pending zoom owns positioning here,
      // exactly as the summary view's "show source sentences" path does.
      if (focus && showSummaryMode) skipNextAlignment();
      setShowSummaryMode(false);
      setChatSentenceNumbers((current) => {
        const next = new Set(current);
        for (let line = startLine; line <= endLine; line += 1) next.add(line);
        return Array.from(next).sort((a, b) => a - b);
      });
    },
    [showSummaryMode, skipNextAlignment],
  );
  const handleClearChatHighlights = useCallback(() => setChatSentenceNumbers([]), []);

  useEffect(() => {
    if (showSummaryMode || pendingChatHighlightLineRef.current === null) return;
    const sentenceNumber = pendingChatHighlightLineRef.current;
    pendingChatHighlightLineRef.current = null;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    const range = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
    if (range) viewport.zoomToTarget(range.getBoundingClientRect());
  }, [chatSentenceNumbers, refreshSentenceRanges, showSummaryMode, viewport]);

  // ── Topic interaction ────────────────────────────────────────────────────

  const { zoomToTopic, panToTopic, handleNavigate, handleShowSourceSentences } =
    useCanvasTopicNavigation({
      showSummaryMode,
      setShowSummaryMode,
      summaryCardRegistry,
      summaryCards,
      summaryMetricsState,
      zoomAdjustedTopicCards,
      selectedLevel,
      selectedTarget,
      selectTopic,
      refreshSentenceRanges,
      viewport,
      flashFocus,
      navigateCanvas,
      skipNextAlignment,
    });

  const handleTopicClick = useCallback(
    (target, card) => {
      toggleTopic(target);
      zoomToTopic(target.path, card);
    },
    [toggleTopic, zoomToTopic],
  );

  // Summary cards zoom on click like the rail's topic cards, but without
  // toggling selection: in summary mode `selectedTarget` feeds the preview's
  // active card, so selecting here would latch a preview open.
  const handleSummaryCardZoom = useCallback(
    (card) => {
      zoomToTopic(card.path, card);
    },
    [zoomToTopic],
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
    const wrap = canvasWrapElRef.current;
    if (wrap && typeof wrap.focus === 'function') {
      wrap.focus({ preventScroll: true });
    }
  }, [canvasWrapElRef]);

  const zoomFromViewportCenter = useCallback(
    (factor) => {
      const wrap = canvasWrapElRef.current;
      if (!wrap) return;
      const currentScale = scaleRef.current || 1;
      const nextScale = clampScale(currentScale * factor);
      if (nextScale === currentScale) return;
      const cursor = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 };
      viewport.zoomAtPoint(cursor, nextScale);
      flashFocus();
    },
    [canvasWrapElRef, flashFocus, scaleRef, viewport],
  );

  const handleZoomIn = useCallback(() => zoomFromViewportCenter(1.2), [zoomFromViewportCenter]);

  const handleZoomOut = useCallback(
    () => zoomFromViewportCenter(1 / 1.2),
    [zoomFromViewportCenter],
  );

  const handleReset = useCallback(() => {
    userMovedCanvasRef.current = true;
    viewport.setTransformNow(1, { x: 40, y: 40 });
  }, [viewport, userMovedCanvasRef]);

  const handleToggleSummaryMode = useCallback(() => {
    if (summariesDisabled) return;
    // Content swaps wholesale (article ⇄ summary cards), so reset the vertical
    // position to the top margin; horizontal stays continuous.
    captureAnchor(true);
    setShowSummaryMode((v) => !v);
  }, [captureAnchor, summariesDisabled]);

  const handleToggleTopicHierarchy = useCallback(() => {
    captureAnchor(false);
    setShowTopicHierarchy((v) => !v);
  }, [captureAnchor]);

  const handleToggleChat = useCallback(() => setShowChat((value) => !value), []);

  const handleCloseChat = useCallback(() => setShowChat(false), []);

  const handleLevelChange = useCallback(
    (level) => {
      // Clicking the already-selected level is a no-op; skip so we never strand
      // a captured anchor that the next real switch would then mis-consume.
      if (level === selectedLevel) return;
      captureAnchor(false);
      setSelectedLevel(level);
      clearSelection();
    },
    [captureAnchor, clearSelection, selectedLevel, setSelectedLevel],
  );

  // ── Opening view: leaf level, zoomed out ~3 clicks, first topic's summary ──
  // Owned by useInitialView: a one-time three-phase state machine that runs once
  // the article and topic hierarchy are measured. See the hook for why the steps
  // are split across separate committed renders.
  const { isSettled: isInitialViewSettled } = useInitialView({
    topics,
    sentenceMetrics,
    maxLevel,
    selectedLevel,
    setSelectedLevel,
    viewport,
    showSummaryMode,
    summaryCards,
    zoomAdjustedTopicCards,
    summaryMetricsState,
    panToTopic,
    selectTopic,
  });

  // ── Opening sequence ─────────────────────────────────────────────────────
  // Measurement and the opening view both move the canvas several times before
  // it settles — on a long article with many topics that reads as cards popping
  // in and jumping around. Keep the (fully rendered, fully measurable) canvas
  // behind an opaque progress overlay until both have settled, then reveal it
  // once with a short entrance animation. See useCanvasStartup for the reveal
  // races that keep the overlay from outstaying its welcome.
  const hasCanvasContent = topics.length > 0 || sentences.length > 0;
  const { isEntering, showOverlay, isOverlayLeaving, progress, statusLabel } = useCanvasStartup({
    hasContent: hasCanvasContent,
    layoutSettled: hasSettledLayout,
    viewSettled: isInitialViewSettled,
  });

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="pagetollm-modal-root">
      <main className="pagetollm-body">
        <div className="pagetollm-canvas-main">
          <div
            ref={canvasWrapRef}
            className={`canvas-area${isCanvasDragging ? ' is-dragging' : ''}${isPanSmoothing ? ' is-pan-smoothing' : ''}`}
            onMouseDown={handleCanvasMouseDown}
            tabIndex={0}
          >
            <div
              ref={canvasViewportRef}
              className={`canvas-viewport${isFocusingHighlight ? ' is-focusing-highlight' : ''}${isCardZoomSmoothing ? ' is-card-zoom-smoothing' : ''}`}
            >
              <div
                ref={summaryWrapRef}
                className={`canvas-article-with-summaries${showTopicHierarchy || showSummaryMode ? ' has-topic-hierarchy' : ''}${showSummaryMode ? ' is-summary-mode' : ''}`}
                style={{
                  '--current-summary-width-fallback': `${currentSummaryWidth}px`,
                }}
              >
                {showSummaryMode ? (
                  <CanvasSummaryView
                    cards={summaryCards}
                    activeTopic={activeTarget}
                    hoveredTopic={hoveredTarget}
                    cardRegistry={summaryCardRegistry}
                    contentRef={articleTextRef}
                    onTopicEnter={enterTopic}
                    onTopicLeave={leaveTopic}
                    onShowSource={handleShowSourceSentences}
                    onZoomToCard={handleSummaryCardZoom}
                    source={sourceDocument}
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
                  activeTopic={activeTarget}
                  selectedTopic={selectedTarget}
                  onTopicEnter={enterTopic}
                  onTopicLeave={leaveTopic}
                  onTopicClick={handleTopicClick}
                  onCancelTopicSelection={clearSelection}
                  currentTopicSummary={currentTopicSummary}
                  sentences={sentences}
                  sourceUrl={record?.sourceUrl}
                  scale={scale}
                  isEntering={isEntering}
                  layoutKey={`${showSummaryMode ? 'summary' : 'article'}:${selectedLevel}`}
                />
              </div>
            </div>
            {showOverlay && (
              <CanvasStartupOverlay
                progress={progress}
                label={statusLabel}
                isLeaving={isOverlayLeaving}
              />
            )}
          </div>

          <CanvasToolbar
            onClose={onClose}
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
            onToggleChat={handleToggleChat}
          />
          <Activity mode={showChat ? 'visible' : 'hidden'}>
            <div className="canvas-chat-panel">
              <ArticleChat
                recordKey={initialKey}
                sentences={sentences}
                onHighlight={handleChatHighlight}
                onClearHighlights={handleClearChatHighlights}
                onClose={handleCloseChat}
              />
            </div>
          </Activity>
        </div>
      </main>
    </div>
  );
}
