import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../../highlights/sentenceHighlight.js';

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
 * Sentence/summary measurement engine for the canvas view.
 *
 * Owns the live DOM Ranges over the rendered article, the measured sentence and
 * summary-card geometry (in scale-independent, wrap-local px), and the layout
 * effects that keep both fresh across mode/level switches, resize, and late
 * image/font loads. The topic-hierarchy rail is positioned from the maps this
 * hook returns; the highlight hook shares its `refreshSentenceRanges`.
 *
 * @param {object} params
 * @param {object} params.articleTextRef
 * @param {object} params.summaryWrapRef
 * @param {object} params.summaryCardRefs
 * @param {object} params.scaleRef
 * @param {boolean} params.isDone
 * @param {boolean} params.showSummaryMode
 * @param {boolean} params.isZoomingToTarget
 * @param {Array<unknown>} params.sentences
 * @param {Array<unknown>} params.summaryCards
 * @param {string} params.articleHtml
 * @returns {{sentenceMetrics: Map<number, {top: number, bottom: number}>, summaryMetricsState: Map<string, {top: number, height: number}>, refreshSentenceRanges: function(): {wordEntries: Array<unknown>, sentenceRanges: Map<number, unknown>}}}
 */
export function useSentenceMetrics({
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
}) {
  const [sentenceMetrics, setSentenceMetrics] = useState(() => new Map());
  const sentenceMetricsRef = useRef(sentenceMetrics);

  // Topic-card positions in summary mode are derived from the rendered
  // summary cards' bounding rects (measured by an effect below).
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());

  // Live DOM Ranges over the rendered article HTML, keyed by sentence number.
  // Built in a layout effect after the HTML mounts; the measurement and highlight
  // effects re-run once layout changes.
  const wordEntriesRef = useRef([]);
  const sentenceRangesRef = useRef(new Map());

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
  }, [articleTextRef, sentences]);

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
  }, [summaryWrapRef, scaleRef, showSummaryMode, isZoomingToTarget, refreshSentenceRanges]);

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
  }, [summaryWrapRef, summaryCardRefs, scaleRef, showSummaryMode]);

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
    summaryWrapRef,
    articleTextRef,
  ]);

  return { sentenceMetrics, summaryMetricsState, refreshSentenceRanges };
}
