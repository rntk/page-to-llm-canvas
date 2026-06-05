import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRecord } from './useRecord.js';
import {
  buildTopicCards,
  getMaxTopicLevel,
  getTopicSentenceNumbers,
  getTopicTitleFontSize,
  getZoomAdjustedCardWidth,
  splitTopicPath,
  COLUMN_GAP,
  RAIL_PADDING,
} from './topicCards.js';

/** Normalize a raw topic.name ("A>B>C") to the rail's canonical form ("A > B > C"). */
function normalizeTopicPath(name) {
  return splitTopicPath(name).join(' > ');
}
import { buildSummaryCards } from './summaryCards.js';
import {
  HIGHLIGHT_NAME,
  supportsHighlightApi,
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from './sentenceHighlight.js';
import { sanitizeArticleHtml, escapeHtml } from './articleHtml.js';
import CanvasTopicHierarchyRail from './components/CanvasTopicHierarchyRail.jsx';
import CanvasSummaryView from './components/CanvasSummaryView.jsx';
import CanvasZoomControls from './components/CanvasZoomControls.jsx';
import SpinnerOverlay from './components/SpinnerOverlay.jsx';
import ArticleHtml from './components/ArticleHtml.jsx';
import { closeModal } from './closeModal.js';
import { useCanvasTransform, clampScale } from './useCanvasTransform.js';

/** Second CSS Custom Highlight name, used for the hovered (not selected) topic. */
const HIGHLIGHT_HOVER = 'pagetollm-sentence-hover';

/**
 * @param {{ initialKey: string }} props
 * @returns {import("react").JSX.Element}
 */
export default function App({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [showSummaryMode, setShowSummaryMode] = useState(false);
  const [showTopicHierarchy, setShowTopicHierarchy] = useState(true);
  const [selectedTopicKey, setSelectedTopicKey] = useState(null);
  const [hoveredTopicKey, setHoveredTopicKey] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(0);
  const [sentenceMetrics, setSentenceMetrics] = useState(() => new Map());
  const [pendingZoomSentence, setPendingZoomSentence] = useState(null);

  const articleTextRef = useRef(null);
  const summaryWrapRef = useRef(null);
  const summaryCardRefs = useRef({});

  // Live DOM Ranges over the rendered article HTML, keyed by sentence number.
  // Built in a layout effect after the HTML mounts; the measurement and highlight
  // effects re-run once layout changes.
  const wordEntriesRef = useRef([]);
  const sentenceRangesRef = useRef(new Map());

  const {
    scale,
    isCanvasDragging,
    isFocusingHighlight,
    canvasWrapRef,
    canvasViewportRef,
    canvasWrapElRef,
    scaleRef,
    translateRef,
    handleMouseDown,
    setTransformNow,
    navigateCanvas,
    zoomToTarget,
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

  const topicsJson = JSON.stringify(record?.topics || null);
  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topicsJson],
  );

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
  const summariesJson = JSON.stringify(record?.topic_summaries || null);
  const summaryIndexJson = JSON.stringify(record?.topic_summary_index || null);
  const allSummaryCards = useMemo(
    () => buildSummaryCards(topics, record?.topic_summaries, record?.topic_summary_index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topics, summariesJson, summaryIndexJson],
  );
  const summaryCards = useMemo(() => {
    // Show one summary per topic branch at the current level: the level-N card
    // if it exists, otherwise the deepest available card for branches that
    // don't go that deep. Cards are ordered by sentence position so they align
    // with the rail visually.
    const eligible = allSummaryCards.filter((card) => card.levelIndex <= selectedLevel);
    const paths = new Set(eligible.map((c) => c.path));
    return eligible
      .filter(
        (card) =>
          !Array.from(paths).some((p) => p !== card.path && p.startsWith(card.path + ' > ')),
      )
      .sort((a, b) => a.startSentence - b.startSentence || a.path.localeCompare(b.path));
  }, [allSummaryCards, selectedLevel]);

  // Topic-card positions in summary mode are derived from the rendered
  // summary cards' bounding rects (measured by an effect below).
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());

  const topicCards = useMemo(() => {
    if (showSummaryMode) {
      // Build cards using synthesized "sentence" indices: each summary card path
      // gets a unique pseudo-sentence number, and the sentenceMetrics map uses
      // those numbers. To keep things simple, we instead patch positions
      // post-build using a path -> {top, height} map.
      const summaryCardMap = new Map(allSummaryCards.map((c) => [c.key, c]));
      const cards = buildTopicCards(topics, selectedLevel, new Map());
      return cards.map((card) => {
        // Find best matching summary card path (exact, ancestor, or descendant).
        const direct = summaryMetricsState.get(card.key);
        if (direct) {
          return { ...card, top: direct.top, height: direct.height };
        }
        let top = Infinity;
        let bottom = -Infinity;
        for (const [key, m] of summaryMetricsState) {
          const path = key.split('#')[0];
          if (
            path === card.fullPath ||
            path.startsWith(card.fullPath + ' > ') ||
            card.fullPath.startsWith(path + ' > ')
          ) {
            const summaryCard = summaryCardMap.get(key);
            if (summaryCard) {
              const start = summaryCard.startSentence;
              const hasOverlap =
                (start >= card.startSentence && start <= card.endSentence) ||
                (card.startSentence === 0 && card.endSentence === 0);
              if (!hasOverlap) {
                continue;
              }
            }
            if (m.top < top) top = m.top;
            if (m.top + m.height > bottom) bottom = m.top + m.height;
          }
        }
        if (Number.isFinite(top) && Number.isFinite(bottom)) {
          return { ...card, top, height: Math.max(72, bottom - top) };
        }
        return card;
      });
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

  const railWidth = useMemo(
    () => (selectedLevel + 1) * cardWidth + selectedLevel * COLUMN_GAP + RAIL_PADDING * 2,
    [selectedLevel, cardWidth],
  );

  const zoomAdjustedTopicCards = useMemo(
    () =>
      topicCards.map((card) => ({
        ...card,
        titleFontSize: getTopicTitleFontSize({ scale, height: card.height }),
        right: RAIL_PADDING + card.levelIndex * (cardWidth + COLUMN_GAP),
      })),
    [scale, cardWidth, topicCards],
  );

  const isDone = record?.status === 'done';
  const isRecordError = record?.status === 'error';
  const isMissing = !record && error === 'record not found';
  const isDeleted = !record && error === 'record deleted';
  const stage = record?.progress?.stage || record?.status || 'loading';

  const activeTopicKey = hoveredTopicKey || selectedTopicKey;

  // The single summary card shown to the left of the article for whichever topic
  // is currently hovered or selected in the rail. Suppressed in summary mode,
  // where every summary is already shown in the center column.
  const currentTopicSummary = useMemo(() => {
    if (showSummaryMode || !activeTopicKey) return null;
    const card = allSummaryCards.find((c) => c.path === activeTopicKey);
    return card && card.text ? card : null;
  }, [showSummaryMode, activeTopicKey, allSummaryCards]);

  // Rebuild word entries + sentence ranges from the *current* article DOM.
  // The Highlight API and measurement hold live Ranges into text nodes; if those
  // nodes are ever replaced by a re-render, the stale Ranges resolve to nothing
  // (getClientRects() returns empty). Rebuilding on demand keeps them pinned to
  // the live, laid-out nodes. Collecting ~1k words is cheap.
  const refreshSentenceRanges = useCallback(() => {
    const articleEl = articleTextRef.current;
    if (!articleEl) return { wordEntries: wordEntriesRef.current, sentenceRanges: sentenceRangesRef.current };
    const wordEntries = collectWordEntries([articleEl]);
    const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
    wordEntriesRef.current = wordEntries;
    sentenceRangesRef.current = sentenceRanges;
    return { wordEntries, sentenceRanges };
  }, [sentences]);

  // Re-build word entries and sentence ranges synchronously before paint whenever layout changes.
  useLayoutEffect(() => {
    if (!isDone || showSummaryMode) return;
    refreshSentenceRanges();
  }, [isDone, showSummaryMode, articleHtml, refreshSentenceRanges]);

  const measureSentencePositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    if (!wrap || showSummaryMode) return;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    if (!sentenceRanges.size) return;

    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const isLaidOut = (r) => r && (r.width > 0 || r.height > 0);
    const nextMetrics = new Map();
    for (const n of sentenceRanges.keys()) {
      const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, n);
      if (!domRange) continue;
      // One rect per line box gives a tighter measurement than the corners and
      // skips collapsed (display:none) fragments that would pin `top` to 0.
      const rects = Array.from(domRange.getClientRects()).filter(isLaidOut);
      if (rects.length === 0) continue;
      const top = (Math.min(...rects.map((r) => r.top)) - wrapRect.top) / s;
      const bottom = (Math.max(...rects.map((r) => r.bottom)) - wrapRect.top) / s;
      nextMetrics.set(n, { top, bottom });
    }
    setSentenceMetrics(nextMetrics);
  }, [scaleRef, showSummaryMode, refreshSentenceRanges]);

  const measureSummaryPositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    if (!wrap || !showSummaryMode) return;
    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const next = new Map();
    Object.entries(summaryCardRefs.current).forEach(([path, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      next.set(path, {
        top: (r.top - wrapRect.top) / s,
        height: r.height / s,
      });
    });
    setSummaryMetricsState(next);
  }, [scaleRef, showSummaryMode]);

  useLayoutEffect(() => {
    if (!isDone) return undefined;
    let raf1 = 0;
    let raf2 = 0;
    const measure = () => {
      measureSentencePositions();
      measureSummaryPositions();
    };
    // Double rAF: the first frame lets the freshly-injected article HTML lay out,
    // the second captures positions after that first reflow settles.
    const schedule = () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      raf1 = window.requestAnimationFrame(() => {
        measure();
        raf2 = window.requestAnimationFrame(measure);
      });
    };
    schedule();
    window.addEventListener('resize', schedule);

    let resizeObserver = null;
    if (typeof window.ResizeObserver !== 'undefined') {
      resizeObserver = new window.ResizeObserver(schedule);
      if (summaryWrapRef.current) resizeObserver.observe(summaryWrapRef.current);
      if (articleTextRef.current) resizeObserver.observe(articleTextRef.current);
    }

    // Images and web fonts in the re-rendered article finish loading *after*
    // the first measurement and shift every sentence below them. Re-measure as
    // each settles so the rail doesn't stay pinned to the pre-load layout.
    const articleEl = articleTextRef.current;
    const images = articleEl ? Array.from(articleEl.querySelectorAll('img')) : [];
    const pending = images.filter((img) => !img.complete);
    pending.forEach((img) => {
      img.addEventListener('load', schedule);
      img.addEventListener('error', schedule);
    });
    let fontsCancelled = false;
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(() => {
        if (!fontsCancelled) schedule();
      });
    }

    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.removeEventListener('resize', schedule);
      if (resizeObserver) resizeObserver.disconnect();
      pending.forEach((img) => {
        img.removeEventListener('load', schedule);
        img.removeEventListener('error', schedule);
      });
      fontsCancelled = true;
    };
  }, [
    isDone,
    showSummaryMode,
    sentences,
    summaryCards,
    articleHtml,
    measureSentencePositions,
    measureSummaryPositions,
  ]);

  // ── Sentence highlighting (native CSS Custom Highlight API) ───────────────
  // A single live Range per sentence paints continuously across whitespace and
  // inline tags. The selected topic and the hovered topic get separate named
  // highlights so they can be styled distinctly via ::highlight() in modal.css.
  useEffect(() => {
    if (!isDone || showSummaryMode || !supportsHighlightApi()) return undefined;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();

    const sentencesForKey = (key) => {
      if (!key) return [];
      const set = new Set();
      for (const t of topics) {
        const path = normalizeTopicPath(t.name);
        if (path === key || path.startsWith(key + ' > ')) {
          for (const idx of getTopicSentenceNumbers(t)) set.add(idx);
        }
      }
      return Array.from(set);
    };

    const setHighlight = (name, nums) => {
      if (!nums.length) {
        CSS.highlights.delete(name);
        return;
      }
      const highlight = new Highlight();
      let any = false;
      for (const n of nums) {
        const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, n);
        if (domRange) {
          highlight.add(domRange);
          any = true;
        }
      }
      if (any) CSS.highlights.set(name, highlight);
      else CSS.highlights.delete(name);
    };

    const selectedNums = sentencesForKey(selectedTopicKey);
    const selectedSet = new Set(selectedNums);
    // Don't double-paint sentences that are already in the selected highlight.
    const hoverNums = sentencesForKey(hoveredTopicKey).filter((n) => !selectedSet.has(n));

    setHighlight(HIGHLIGHT_NAME, selectedNums);
    setHighlight(HIGHLIGHT_HOVER, hoverNums);

    return () => {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(HIGHLIGHT_HOVER);
    };
  }, [
    isDone,
    showSummaryMode,
    topics,
    selectedTopicKey,
    hoveredTopicKey,
    articleHtml,
    refreshSentenceRanges,
  ]);

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
    if (showSummaryMode || pendingZoomSentence === null) return;
    setPendingZoomSentence(null);
    const sentenceNumber = Number(pendingZoomSentence);
    if (Number.isInteger(sentenceNumber) && sentenceNumber > 0) {
      const { wordEntries, sentenceRanges } = refreshSentenceRanges();
      const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
      if (domRange) {
        zoomToTarget(domRange.getBoundingClientRect());
      }
    }
  }, [showSummaryMode, pendingZoomSentence, zoomToTarget, refreshSentenceRanges]);

  // ── Focus ────────────────────────────────────────────────────────────────
  // The modal runs inside an iframe. Keyboard listeners on the iframe's
  // window only fire when the iframe itself has focus, so pull focus in as
  // soon as the canvas mounts and whenever the user clicks inside it.
  useEffect(() => {
    if (!isDone) return;
    try {
      window.focus();
    } catch (_) {
      /* noop */
    }
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
    chrome.runtime.sendMessage({ type: 'ensurePipeline', key: initialKey }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('PageToLLM Canvas ensurePipeline error:', chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        console.warn('PageToLLM Canvas ensurePipeline failed:', resp.error);
      }
    });
  }, [initialKey]);

  const handleRetry = useCallback(() => {
    if (!initialKey) return;
    chrome.runtime.sendMessage({ type: 'retryRecord', key: initialKey }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('PageToLLM Canvas retry error:', chrome.runtime.lastError.message);
      } else if (resp && !resp.ok) {
        console.warn('PageToLLM Canvas retry failed:', resp.error);
      }
    });
  }, [initialKey]);

  const handleTopicEnter = useCallback((k) => {
    setHoveredTopicKey(k);
  }, []);

  const handleTopicLeave = useCallback((k) => {
    setHoveredTopicKey((cur) => (cur === k ? null : cur));
  }, []);

  const handleTopicClick = useCallback(
    (k, card) => {
      setSelectedTopicKey((cur) => (cur === k ? null : k));
      zoomToTopic(k, card);
    },
    [zoomToTopic],
  );

  const handleShowSourceSentences = useCallback((card) => {
    setSelectedTopicKey(card.path);
    setShowSummaryMode(false);
    setPendingZoomSentence(card.startSentence);
  }, []);
  const handleZoomIn = useCallback(() => {
    setTransformNow(clampScale((scaleRef.current || 1) * 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef]);

  const handleZoomOut = useCallback(() => {
    setTransformNow(clampScale((scaleRef.current || 1) / 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef]);

  const handleReset = useCallback(() => {
    setTransformNow(1, { x: 40, y: 40 });
  }, [setTransformNow]);

  const handleToggleSummaryMode = useCallback(() => {
    setShowSummaryMode((v) => !v);
  }, []);

  const handleToggleTopicHierarchy = useCallback(() => {
    setShowTopicHierarchy((v) => !v);
  }, []);

  const handleLevelChange = useCallback((level) => {
    setSelectedLevel(level);
    setHoveredTopicKey(null);
    setSelectedTopicKey(null);
  }, []);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="pagetollm-modal-root">
      <main className="pagetollm-body">
        {!isDone && (
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
                  }}
                >
                  {showSummaryMode ? (
                    <CanvasSummaryView
                      summaryViewCards={summaryCards}
                      summaryViewActivePath={activeTopicKey}
                      summaryCardRefs={summaryCardRefs}
                      setHoveredTopicKey={setHoveredTopicKey}
                      articleTextRef={articleTextRef}
                      onShowSourceSentences={handleShowSourceSentences}
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
                    selectedTopicKey={selectedTopicKey}
                    onTopicEnter={handleTopicEnter}
                    onTopicLeave={handleTopicLeave}
                    onTopicClick={handleTopicClick}
                    readTopics={null}
                    onToggleRead={null}
                    currentTopicSummary={currentTopicSummary}
                  />
                </div>
              </div>
            </div>

            <CanvasZoomControls
              onClose={closeModal}
              onNavigate={navigateCanvas}
              onZoomIn={handleZoomIn}
              onZoomOut={handleZoomOut}
              onReset={handleReset}
              showSummaryMode={showSummaryMode}
              onToggleSummaryMode={handleToggleSummaryMode}
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
