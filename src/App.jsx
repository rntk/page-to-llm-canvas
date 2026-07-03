import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useRecord } from './useRecord.js';
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
import SummaryErrorsOverlay from './components/SummaryErrorsOverlay.jsx';
import ArticleHtml from './components/ArticleHtml.jsx';
import { closeModal } from './closeModal.js';
import { useCanvasTransform, clampScale } from './useCanvasTransform.js';
import { useCanvasAlignment } from './useCanvasAlignment.js';
import { retryRecord, resolveSummaryErrors } from './utils/errorUtils.js';
import { selectCurrentTopicSummary } from './utils/currentTopicSummary.js';
import {
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationCardKey,
  getTopicNavigationCardTop,
  getTopicNavigationTopicKey,
} from './topicNavigation.js';

/** Second CSS Custom Highlight name, used for the hovered (not selected) topic. */
const HIGHLIGHT_HOVER = 'pagetollm-sentence-hover';

function areSentenceMetricsEqual(prevMetrics, nextMetrics) {
  if (prevMetrics === nextMetrics) return true;
  if (!(prevMetrics instanceof Map) || !(nextMetrics instanceof Map)) return false;
  if (prevMetrics.size !== nextMetrics.size) return false;
  for (const [sentenceNumber, nextMetric] of nextMetrics) {
    const prevMetric = prevMetrics.get(sentenceNumber);
    if (
      !prevMetric ||
      !Object.is(prevMetric.top, nextMetric.top) ||
      !Object.is(prevMetric.bottom, nextMetric.bottom)
    ) {
      return false;
    }
  }
  return true;
}

function areSummaryMetricsEqual(prevMetrics, nextMetrics) {
  if (prevMetrics === nextMetrics) return true;
  if (!(prevMetrics instanceof Map) || !(nextMetrics instanceof Map)) return false;
  if (prevMetrics.size !== nextMetrics.size) return false;
  for (const [path, nextMetric] of nextMetrics) {
    const prevMetric = prevMetrics.get(path);
    if (
      !prevMetric ||
      !Object.is(prevMetric.top, nextMetric.top) ||
      !Object.is(prevMetric.height, nextMetric.height)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * @param {{ initialKey: string }} props
 * @returns {import("react").JSX.Element}
 */
export default function App({ initialKey }) {
  const { record, error } = useRecord(initialKey);
  const [showSummaryMode, setShowSummaryMode] = useState(false);
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
  // Drives the one-time "opening view" setup below: leaf-level rail, zoomed out
  // enough to see a few levels of cards at once, first topic's summary shown.
  // Split into phases (rather than one effect) because each step depends on
  // state set by the previous one having actually committed and re-rendered
  // (e.g. the topic cards for the leaf level only exist after `selectedLevel`
  // itself has updated) — a single effect closure would read stale values.
  const [initialViewPhase, setInitialViewPhase] = useState('pending');
  const [sentenceMetrics, setSentenceMetrics] = useState(() => new Map());
  const sentenceMetricsRef = useRef(sentenceMetrics);
  const pendingZoomSentenceRef = useRef(null);

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

  // Topic-card positions in summary mode are derived from the rendered
  // summary cards' bounding rects (measured by an effect below).
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());

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

  const isDone = record?.status === 'done';

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
    return selectCurrentTopicSummary({
      showSummaryMode,
      activeTopicKey,
      activeTopicCardKey,
      allSummaryCards,
    });
  }, [showSummaryMode, activeTopicKey, activeTopicCardKey, allSummaryCards]);

  // Rebuild word entries + sentence ranges from the *current* article DOM.
  // The Highlight API and measurement hold live Ranges into text nodes; if those
  // nodes are ever replaced by a re-render, the stale Ranges resolve to nothing
  // (getClientRects() returns empty). Rebuilding on demand keeps them pinned to
  // the live, laid-out nodes. Collecting ~1k words is cheap.
  const refreshSentenceRanges = useCallback(() => {
    const articleEl = articleTextRef.current;
    if (!articleEl)
      return { wordEntries: wordEntriesRef.current, sentenceRanges: sentenceRangesRef.current };
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
    // While a zoom-to-sentence animation is in flight (e.g. after "Show source
    // sentences" exits summary mode), the canvas transform is mid-transition but
    // `scaleRef` already holds the *target* scale. Measuring now divides settled-
    // scale into animating rects, yielding wrong (tiny, top-pinned) sentence
    // positions that pin the rail cards to a small stacked layout. Skip until the
    // transform settles; `isZoomingToTarget` is in the deps so flipping it back
    // to false re-runs the measurement effects with the final layout. (Ordinary
    // pan only flashes the focus glow and never sets this flag, so pan no longer
    // recreates this callback or reschedules the remeasure.)
    if (!wrap || showSummaryMode || isZoomingToTarget) return;
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
    if (nextMetrics.size > 0) {
      if (!areSentenceMetricsEqual(sentenceMetricsRef.current, nextMetrics)) {
        sentenceMetricsRef.current = nextMetrics;
        setSentenceMetrics(nextMetrics);
      }
    }
  }, [scaleRef, showSummaryMode, isZoomingToTarget, refreshSentenceRanges]);

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
    // The triple-rAF measurement schedule calls this up to 3x per layout pass;
    // bail the render when geometry is unchanged so we don't thrash the rail.
    setSummaryMetricsState((prev) => (areSummaryMetricsEqual(prev, next) ? prev : next));
  }, [scaleRef, showSummaryMode]);

  // When leaving summary mode (e.g. via "Show source sentences"), ensure we
  // (re)measure sentence positions against the freshly mounted article DOM so
  // that topic cards in the rail are built from real measured layouts (tall,
  // article-aligned) rather than falling back to the synthetic small stacked
  // layout near the top.
  const prevShowSummaryRef = useRef(showSummaryMode);
  useLayoutEffect(() => {
    const wasInSummary = prevShowSummaryRef.current;
    prevShowSummaryRef.current = showSummaryMode;
    if (wasInSummary && !showSummaryMode) {
      // Schedule after paint so getClientRects on the article sentences are valid.
      const raf = window.requestAnimationFrame(() => {
        measureSentencePositions();
      });
      return () => window.cancelAnimationFrame(raf);
    }
  }, [showSummaryMode, measureSentencePositions]);

  useLayoutEffect(() => {
    if (!isDone) return undefined;
    let raf1 = 0;
    let raf2 = 0;
    let raf3 = 0;
    const measure = () => {
      measureSentencePositions();
      measureSummaryPositions();
    };
    // Triple rAF on layout changes (incl. summary<->article switches): gives the
    // injected article (or summary cards) time to lay out before we sample
    // sentence/summary rects for rail card positioning. Extra attempts guard
    // against races where early passes see no client rects and would otherwise
    // leave topic cards stuck in the small synthetic fallback layout.
    // Track and cancel the third rAF callback: when the effect is cleaned up
    // after the second animation frame has scheduled this third measurement,
    // cleanup must cancel it too. Otherwise it can still run after a mode switch
    // or unmount, using stale showSummaryMode / measure* closures and writing
    // metrics for the wrong DOM.
    const schedule = () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
      window.cancelAnimationFrame(raf3);
      raf1 = window.requestAnimationFrame(() => {
        measure();
        raf2 = window.requestAnimationFrame(() => {
          measure();
          raf3 = window.requestAnimationFrame(measure);
        });
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
      window.cancelAnimationFrame(raf3);
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
      return Array.from(topicSentenceIndex.get(key) || []);
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
    topicSentenceIndex,
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
    setTransformNow(clampScale((scaleRef.current || 1) * 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef]);

  const handleZoomOut = useCallback(() => {
    setTransformNow(clampScale((scaleRef.current || 1) / 1.2), translateRef.current);
  }, [setTransformNow, scaleRef, translateRef]);

  const handleReset = useCallback(() => {
    setTransformNow(1, { x: 40, y: 40 });
  }, [setTransformNow]);

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
    // Content swaps wholesale (article ⇄ summary cards), so reset the vertical
    // position to the top margin; horizontal stays continuous.
    captureAnchor(true);
    setShowSummaryMode((v) => !v);
  }, [captureAnchor]);

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
  // Phase 1: once the article and its topic hierarchy are measured, jump the
  // level switcher straight to the leaf level (mirrors clicking it manually).
  useEffect(() => {
    if (initialViewPhase !== 'pending') return;
    if (!isDone || topics.length === 0 || sentenceMetrics.size === 0) return;
    // The user already touched the canvas (panned/zoomed/switched level) while
    // this settled — don't yank their view out from under them.
    if (userMovedCanvasRef.current || selectedLevel !== 0) {
      setInitialViewPhase('done');
      return;
    }
    if (maxLevel > 0) {
      setSelectedLevel(maxLevel);
    }
    setInitialViewPhase('level-set');
  }, [initialViewPhase, isDone, topics, sentenceMetrics, maxLevel, selectedLevel, userMovedCanvasRef]);

  // Phase 2: once the leaf level has actually committed, zoom out the
  // equivalent of 3 "-" clicks so a few levels of cards fit on screen.
  useEffect(() => {
    if (initialViewPhase !== 'level-set') return;
    if (maxLevel > 0 && selectedLevel !== maxLevel) return;
    setTransformNow(clampScale((scaleRef.current || 1) / 1.2 ** 3), translateRef.current);
    setInitialViewPhase('zoomed');
  }, [initialViewPhase, selectedLevel, maxLevel, setTransformNow, scaleRef, translateRef]);

  // Phase 3: with the leaf-level cards and zoom settled, select the first
  // topic — same as clicking "First topic" once — so its summary is visible.
  useEffect(() => {
    if (initialViewPhase !== 'zoomed') return;
    const list = buildTopicNavigationList({
      showSummaryMode,
      summaryCards,
      topicCards: zoomAdjustedTopicCards,
      selectedLevel,
    });
    const targetCard = findTopicNavigationTarget({
      list,
      selectedNavigationKey: null,
      selectedTopicKey: null,
      direction: 'first',
      currentY: 0,
      showSummaryMode,
      summaryMetricsState,
    });
    if (targetCard) {
      setSelectedTopicKey(getTopicNavigationTopicKey(targetCard, showSummaryMode));
      setSelectedTopicCardKey(getTopicNavigationCardKey(targetCard, showSummaryMode));
      panToTopic(targetCard);
    }
    setInitialViewPhase('done');
  }, [
    initialViewPhase,
    showSummaryMode,
    summaryCards,
    zoomAdjustedTopicCards,
    selectedLevel,
    summaryMetricsState,
    panToTopic,
  ]);

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
