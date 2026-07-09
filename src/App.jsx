import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRecord } from './useRecord.js';
import { MSG } from '../messages.js';
import {
  buildTopicSentenceIndex,
  buildTopicCards,
  getMaxTopicLevel,
  getTopicTitleFontSize,
  getZoomAdjustedCardWidth,
  getZoomAdjustedSummaryCardWidth,
  patchTopicCardsFromSummaryMetrics,
  COLUMN_GAP,
  RAIL_PADDING,
} from './topicCards.js';
import { buildSummaryCards, filterSummaryCardsByLevel } from './summaryCards.js';
import { buildSentenceDomRange } from './sentenceHighlight.js';
import { sanitizeArticleHtml, escapeHtml } from './articleHtml.js';
import CanvasTopicHierarchyRail from './components/CanvasTopicHierarchyRail.jsx';
import CanvasSummaryView from './components/CanvasSummaryView.jsx';
import CanvasZoomControls from './components/CanvasZoomControls.jsx';
import SpinnerOverlay from './components/SpinnerOverlay.jsx';
import SummaryErrorsOverlay from './components/SummaryErrorsOverlay.jsx';
import ArticleHtml from './components/ArticleHtml.jsx';
import { closeModal } from './closeModal.js';
import { useCanvasTransform, clampScale } from './useCanvasTransform.js';
import { useCanvasAlignment } from './useCanvasAlignment.js';
import { useSentenceMetrics } from './useSentenceMetrics.js';
import { useSentenceHighlights } from './useSentenceHighlights.js';
import { useInitialView } from './useInitialView.js';
import { retryRecord, resolveSummaryErrors } from './utils/errorUtils.js';
import { selectCurrentTopicSummary } from './utils/currentTopicSummary.js';
import {
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationCardKey,
  getTopicNavigationCardTop,
  getTopicNavigationTopicKey,
} from './topicNavigation.js';

/**
 * @param {{ initialKey: string }} props
 * @returns {import("react").JSX.Element}
 */
export default function App({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [showSummaryModeRaw, setShowSummaryMode] = useState(false);
  const [showTopicHierarchy, setShowTopicHierarchy] = useState(true);
  const [selectedTopicKey, setSelectedTopicKey] = useState(null);
  const [selectedTopicCardKey, setSelectedTopicCardKey] = useState(null);
  // Mirrored in a ref so callbacks can read the current selection without taking
  // it as a dependency (keeps their identity stable across selection changes).
  const selectedTopicCardKeyRef = useRef(selectedTopicCardKey);
  useEffect(() => {
    selectedTopicCardKeyRef.current = selectedTopicCardKey;
  }, [selectedTopicCardKey]);
  const [hoveredTopicKey, setHoveredTopicKey] = useState(null);
  const [hoveredTopicCardKey, setHoveredTopicCardKey] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(0);
  const pendingZoomSentenceRef = useRef(null);

  const articleTextRef = useRef(null);
  const summaryWrapRef = useRef(null);
  const summaryCardRefs = useRef({});

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

  // Serialize once per record change, not once per render. `record` is referentially
  // stable across UI interactions (hover/zoom/level — only storage writes mint a new
  // object), so keying on `record?.topics` skips the stringify on the ~60fps render
  // storm that pan/zoom drives through `setScale`/`setTranslate`. Storage writes still
  // produce a fresh object, so content-dedup across pipeline rewrites is preserved by
  // the downstream memos keying on the resulting string.
  const topicsJson = useMemo(() => JSON.stringify(record?.topics || null), [record?.topics]);
  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topicsJson],
  );
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);

  // Keep a referentially-stable `sentences` array across record writes that
  // don't actually change the sentences. The orchestrator rewrites the record
  // several times after `status: done` (e.g. the `pipeline_done` processing-log
  // entry, `updatedAt` bumps). Each write hands `useRecord` a brand-new object,
  // so a naive `[record]` memo would yield a new array every time and thrash
  // every downstream effect (range rebuild, measurement, highlight repaint).
  // Sentences are immutable once extracted, so their count is a cheap, stable
  // identity key — the memo only produces a new array when the count changes.
  const sentenceCount = Array.isArray(record?.sentences) ? record.sentences.length : 0;
  const sentences = useMemo(
    () => (Array.isArray(record?.sentences) ? record.sentences : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sentenceCount],
  );

  // Prefer the original article markup for readability; fall back to a plain
  // paragraph of sentences when a record predates HTML capture. Keyed on the raw
  // HTML (not the whole record) so unrelated record writes never recompute it,
  // keeping the string identity — and thus the rendered subtree and the live
  // highlight Ranges that point into it — stable.
  const articleHtml = useMemo(() => {
    const html = record?.html;
    if (html) return sanitizeArticleHtml(html);
    if (sentences.length) return `<p>${sentences.map(escapeHtml).join(' ')}</p>`;
    return '';
  }, [record?.html, sentences]);

  const maxLevel = useMemo(() => getMaxTopicLevel(topics), [topics]);
  const summariesJson = useMemo(
    () => JSON.stringify(record?.topic_summaries || null),
    [record?.topic_summaries],
  );
  const summaryIndexJson = useMemo(
    () => JSON.stringify(record?.topic_summary_index || null),
    [record?.topic_summary_index],
  );
  const allSummaryCards = useMemo(
    () => buildSummaryCards(topics, record?.topic_summaries, record?.topic_summary_index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topics, summariesJson, summaryIndexJson],
  );
  const summaryCards = useMemo(
    () => filterSummaryCardsByLevel(allSummaryCards, selectedLevel),
    [allSummaryCards, selectedLevel],
  );

  const isDone = record?.status === 'done';
  // Summaries are optional: a pipeline run with them disabled still finishes
  // 'done' with topics/sentences/html intact, but empty topic_summaries/
  // topic_summary_index. Summary mode (which renders summary cards instead of
  // the article) has nothing to show in that case.
  const summariesDisabled = record?.summariesDisabled === true;
  // Derived (not reset via an effect) so a live record update that flips
  // summariesDisabled on — reprocess with the toggle enabled — exits summary
  // mode immediately instead of rendering an empty card column for a frame.
  const showSummaryMode = showSummaryModeRaw && !summariesDisabled;

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

  const isNeedsAttention = record?.status === 'needs_attention';
  const isRecordError = record?.status === 'error' || record?.status === 'cancelled';
  const isMissing = !record && error === 'record not found';
  const isDeleted = !record && error === 'record deleted';
  const stage = record?.progress?.stage || record?.status || 'loading';

  const activeTopicKey = hoveredTopicKey || selectedTopicKey;
  const activeTopicCardKey = hoveredTopicCardKey || selectedTopicCardKey;

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

  // ── Topic interaction ────────────────────────────────────────────────────

  const zoomToTopic = useCallback(
    (topicKey, card) => {
      if (!topicKey) return;
      if (showSummaryMode) {
        const summaryEl =
          (card && summaryCardRefs.current[card.key]) ||
          summaryCardRefs.current[topicKey] ||
          Object.entries(summaryCardRefs.current).find(([key]) => {
            const path = key.split('#')[0];
            return path === topicKey || path.startsWith(topicKey + ' > ');
          })?.[1];
        if (summaryEl) {
          zoomToTarget(summaryEl.getBoundingClientRect());
        }
        return;
      }
      const sentenceNumber = Number(card?.startSentence);
      const { wordEntries, sentenceRanges } = refreshSentenceRanges();
      const domRange =
        Number.isInteger(sentenceNumber) && sentenceNumber > 0
          ? buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber)
          : null;
      if (domRange) {
        zoomToTarget(domRange.getBoundingClientRect());
      }
    },
    [showSummaryMode, zoomToTarget, refreshSentenceRanges],
  );

  useEffect(() => {
    // Wait until we're in article mode (the article DOM must be mounted) before
    // resolving the queued sentence to a live range and zooming to it.
    if (showSummaryMode || pendingZoomSentenceRef.current === null) return;
    const sentenceNumber = Number(pendingZoomSentenceRef.current);
    pendingZoomSentenceRef.current = null;
    if (Number.isInteger(sentenceNumber) && sentenceNumber > 0) {
      const { wordEntries, sentenceRanges } = refreshSentenceRanges();
      const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
      if (domRange) {
        zoomToTarget(domRange.getBoundingClientRect());
      }
    }
  }, [showSummaryMode, zoomToTarget, refreshSentenceRanges]);

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

  const handleTopicEnter = useCallback((k, cardKey = null) => {
    setHoveredTopicKey(k);
    setHoveredTopicCardKey(cardKey);
  }, []);

  const handleTopicLeave = useCallback((k, cardKey = null) => {
    setHoveredTopicKey((cur) => (cur === k ? null : cur));
    setHoveredTopicCardKey((cur) => (!cardKey || cur === cardKey ? null : cur));
  }, []);

  const handleTopicClick = useCallback(
    (k, card) => {
      const cardKey = card?.key || k;
      const shouldDeselect = selectedTopicCardKeyRef.current === cardKey;
      setSelectedTopicKey(shouldDeselect ? null : k);
      setSelectedTopicCardKey(shouldDeselect ? null : cardKey);
      zoomToTopic(k, card);
    },
    [zoomToTopic],
  );

  const handleCancelTopicSelection = useCallback(() => {
    setSelectedTopicKey(null);
    setSelectedTopicCardKey(null);
    setHoveredTopicKey(null);
    setHoveredTopicCardKey(null);
  }, []);

  const handleShowSourceSentences = useCallback(
    (card) => {
      // Leaving summary mode here hands positioning to the pending zoom-to-
      // sentence effect, so suppress alignment to avoid a glide-then-yank.
      skipNextAlignment();
      pendingZoomSentenceRef.current = card.startSentence;
      setSelectedTopicKey(card.path);
      setSelectedTopicCardKey(card.key || card.path);
      setShowSummaryMode(false);
    },
    [skipNextAlignment],
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

  const panToTopic = useCallback(
    (card) => {
      const wrap = canvasWrapElRef.current;
      if (!wrap || !card) return;
      const currentScale = scaleRef.current || 1;
      const currentTranslate = translateRef.current;
      const cardTop = getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState);
      if (!Number.isFinite(cardTop)) return;
      setTransformNow(currentScale, {
        ...currentTranslate,
        y: wrap.clientHeight * 0.2 - cardTop * currentScale,
      });
      flashFocus();
    },
    [
      canvasWrapElRef,
      flashFocus,
      scaleRef,
      setTransformNow,
      showSummaryMode,
      summaryMetricsState,
      translateRef,
    ],
  );

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
      setHoveredTopicKey(null);
      setHoveredTopicCardKey(null);
      setSelectedTopicKey(null);
      setSelectedTopicCardKey(null);
    },
    [captureAnchor, selectedLevel],
  );

  const handleNavigate = useCallback(
    (pos) => {
      if (
        pos === 'first-topic' ||
        pos === 'prev-topic' ||
        pos === 'next-topic' ||
        pos === 'last-topic'
      ) {
        const directionByPosition = {
          'first-topic': 'first',
          'prev-topic': 'prev',
          'next-topic': 'next',
          'last-topic': 'last',
        };
        const list = buildTopicNavigationList({
          showSummaryMode,
          summaryCards,
          topicCards: zoomAdjustedTopicCards,
          selectedLevel,
        });
        const currentY = -translateRef.current.y / (scaleRef.current || 1);
        const targetCard = findTopicNavigationTarget({
          list,
          selectedNavigationKey: selectedTopicCardKey,
          selectedTopicKey,
          direction: directionByPosition[pos],
          currentY,
          showSummaryMode,
          summaryMetricsState,
        });

        if (!targetCard) return;
        const targetKey = getTopicNavigationTopicKey(targetCard, showSummaryMode);
        const targetCardKey = getTopicNavigationCardKey(targetCard, showSummaryMode);
        setSelectedTopicKey(targetKey);
        setSelectedTopicCardKey(targetCardKey);
        panToTopic(targetCard);
      } else {
        navigateCanvas(pos);
      }
    },
    [
      showSummaryMode,
      summaryCards,
      zoomAdjustedTopicCards,
      selectedLevel,
      selectedTopicKey,
      selectedTopicCardKey,
      translateRef,
      scaleRef,
      summaryMetricsState,
      panToTopic,
      navigateCanvas,
    ],
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
                    onCancelTopicSelection={handleCancelTopicSelection}
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
            />
          </div>
        )}
      </main>
    </div>
  );
}
