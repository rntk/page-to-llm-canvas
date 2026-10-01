import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../../highlights/sentenceHighlight.js';
import { ENTRANCE_SETTLE_MS } from '../../utils/cardEntrance.js';

// Bound retries if layout never settles.
const MAX_MEASURE_PASSES = 4;

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
 * Keeps article Ranges and wrap-local sentence/summary geometry current across
 * layout changes. The rail consumes the maps; highlights use `refreshSentenceRanges`.
 *
 * @param {object} params
 * @param {object} params.articleTextRef
 * @param {object} params.summaryWrapRef
 * @param {{get: function(string): ?Element, entries: function(): Array<[string, Element]>, register: function(string, ?Element): void}} params.summaryCardRegistry
 * @param {object} params.scaleRef
 * @param {boolean} params.showSummaryMode
 * @param {boolean} params.isZoomingToTarget
 * @param {Array<unknown>} params.sentences
 * @param {Array<unknown>} params.summaryCards
 * @param {string} params.articleHtml
 * @returns {{sentenceMetrics: Map<number, {top: number, bottom: number}>, summaryMetricsState: Map<string, {top: number, height: number}>, refreshSentenceRanges: function(): {wordEntries: Array<unknown>, sentenceRanges: Map<number, unknown>}, hasSettledLayout: boolean}}
 */
export function useSentenceMetrics({
  articleTextRef,
  summaryWrapRef,
  summaryCardRegistry,
  scaleRef,
  showSummaryMode,
  isZoomingToTarget,
  sentences,
  summaryCards,
  articleHtml,
}) {
  const [sentenceMetrics, setSentenceMetrics] = useState(() => new Map());
  const sentenceMetricsRef = useRef(sentenceMetrics);

  // Summary mode positions topics from rendered card bounds.
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());
  const summaryMetricsRef = useRef(summaryMetricsState);

  // Latches after the first settle or pass cap; later remeasures do not hide the canvas.
  const [hasSettledLayout, setHasSettledLayout] = useState(false);
  const hasSettledLayoutRef = useRef(false);

  const wordEntriesRef = useRef([]);
  const sentenceRangesRef = useRef(new Map());

  // Identity of the article DOM the cached walk below was built from.
  const rangeCacheRef = useRef({ el: null, html: null, sentences: null });

  // Cache the expensive DOM walk by element, HTML, and sentences. Probe node
  // liveness because a re-render may replace text nodes without changing them.
  const refreshSentenceRanges = useCallback(() => {
    const articleEl = articleTextRef.current;
    if (!articleEl)
      return { wordEntries: wordEntriesRef.current, sentenceRanges: sentenceRangesRef.current };
    const cache = rangeCacheRef.current;
    if (cache.el === articleEl && cache.html === articleHtml && cache.sentences === sentences) {
      const sampleNode = wordEntriesRef.current[0]?.node;
      if (sampleNode && sampleNode.isConnected) {
        return { wordEntries: wordEntriesRef.current, sentenceRanges: sentenceRangesRef.current };
      }
    }
    const wordEntries = collectWordEntries([articleEl]);
    const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
    wordEntriesRef.current = wordEntries;
    sentenceRangesRef.current = sentenceRanges;
    rangeCacheRef.current = { el: articleEl, html: articleHtml, sentences };
    return { wordEntries, sentenceRanges };
  }, [articleTextRef, sentences, articleHtml]);

  // Refresh Ranges before paint when the article changes.
  useLayoutEffect(() => {
    if (showSummaryMode) return;
    refreshSentenceRanges();
  }, [showSummaryMode, articleHtml, refreshSentenceRanges]);

  const measureSentencePositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    // During target zoom, scaleRef has the final scale but rects are still moving.
    // Measure again once the animation ends.
    if (!wrap || showSummaryMode || isZoomingToTarget) return null;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    if (!sentenceRanges.size) return sentences.length === 0;

    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const isLaidOut = (r) => r && (r.width > 0 || r.height > 0);
    // Source styles can position text outside the article. Drop off-sheet rects
    // and clamp the rest; skip clamping when the sheet has no measured height.
    const articleRect = articleTextRef.current?.getBoundingClientRect();
    const sheet = articleRect && articleRect.height > 0 ? articleRect : null;
    const isOnSheet = (r) => !sheet || (r.bottom > sheet.top && r.top < sheet.bottom);
    const nextMetrics = new Map();
    for (const n of sentenceRanges.keys()) {
      const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, n);
      if (!domRange) continue;
      // Line rects exclude collapsed fragments and give tighter bounds.
      const rects = Array.from(domRange.getClientRects()).filter(isLaidOut).filter(isOnSheet);
      if (rects.length === 0) continue;
      let rectTop = Math.min(...rects.map((r) => r.top));
      let rectBottom = Math.max(...rects.map((r) => r.bottom));
      if (sheet) {
        rectTop = Math.max(rectTop, sheet.top);
        rectBottom = Math.min(rectBottom, sheet.bottom);
      }
      const top = (rectTop - wrapRect.top) / s;
      const bottom = (rectBottom - wrapRect.top) / s;
      nextMetrics.set(n, { top, bottom });
    }
    // An unlaid-out article needs another pass.
    if (nextMetrics.size === 0) return sentences.length === 0;
    if (areSentenceMetricsEqual(sentenceMetricsRef.current, nextMetrics)) return true;
    sentenceMetricsRef.current = nextMetrics;
    setSentenceMetrics(nextMetrics);
    return false;
  }, [
    articleTextRef,
    summaryWrapRef,
    scaleRef,
    showSummaryMode,
    isZoomingToTarget,
    refreshSentenceRanges,
    sentences,
  ]);

  const measureSummaryPositions = useCallback(() => {
    const wrap = summaryWrapRef.current;
    if (!wrap || !showSummaryMode) return null;
    const wrapRect = wrap.getBoundingClientRect();
    const s = scaleRef.current || 1;
    const next = new Map();
    summaryCardRegistry.entries().forEach(([path, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      next.set(path, {
        top: (r.top - wrapRect.top) / s,
        height: r.height / s,
      });
    });
    // Expected cards may not have registered their elements yet.
    if (next.size === 0 && summaryCards.length > 0) return false;
    // Skip unchanged geometry to avoid rail renders.
    if (areSummaryMetricsEqual(summaryMetricsRef.current, next)) return true;
    summaryMetricsRef.current = next;
    setSummaryMetricsState(next);
    return false;
  }, [summaryWrapRef, summaryCardRegistry, scaleRef, showSummaryMode, summaryCards]);

  useLayoutEffect(() => {
    let raf = 0;
    let passes = 0;

    // Settled means every applicable measurement matches its previous value.
    const measure = () => {
      const sentenceResult = measureSentencePositions();
      const summaryResult = measureSummaryPositions();
      const results = [sentenceResult, summaryResult].filter((result) => result !== null);
      // Mid-zoom has no measurement; retry only before the first settle.
      if (results.length === 0) return hasSettledLayoutRef.current;
      return results.every(Boolean);
    };

    const markSettled = () => {
      if (hasSettledLayoutRef.current) return;
      hasSettledLayoutRef.current = true;
      setHasSettledLayout(true);
    };

    // Retry until geometry converges or the pass cap is reached. Cancel queued
    // frames on cleanup so they cannot measure stale DOM after a mode switch.
    const runPass = () => {
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        passes += 1;
        const settled = measure();
        if (settled || passes >= MAX_MEASURE_PASSES) {
          markSettled();
          return;
        }
        runPass();
      });
    };
    const schedule = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
      passes = 0;
      runPass();
    };
    schedule();
    window.addEventListener('resize', schedule);

    let resizeObserver = null;
    if (typeof window.ResizeObserver !== 'undefined') {
      resizeObserver = new window.ResizeObserver(schedule);
      if (summaryWrapRef.current) resizeObserver.observe(summaryWrapRef.current);
      if (articleTextRef.current) resizeObserver.observe(articleTextRef.current);
    }

    // Late image and font loads can shift sentence positions.
    const articleEl = articleTextRef.current;
    const images = articleEl ? Array.from(articleEl.querySelectorAll('img')) : [];
    const pending = images.filter((img) => !img.complete);
    pending.forEach((img) => {
      img.addEventListener('load', schedule);
      img.addEventListener('error', schedule);
    });
    // The entrance translateY affects rects but triggers no resize; measure
    // summary cards again after the last animation.
    const entranceTimer = showSummaryMode ? setTimeout(schedule, ENTRANCE_SETTLE_MS) : 0;

    let fontsCancelled = false;
    if (document.fonts && typeof document.fonts.ready?.then === 'function') {
      document.fonts.ready.then(() => {
        if (!fontsCancelled) schedule();
      });
    }

    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      if (entranceTimer) clearTimeout(entranceTimer);
      window.removeEventListener('resize', schedule);
      if (resizeObserver) resizeObserver.disconnect();
      pending.forEach((img) => {
        img.removeEventListener('load', schedule);
        img.removeEventListener('error', schedule);
      });
      fontsCancelled = true;
    };
  }, [
    showSummaryMode,
    sentences,
    summaryCards,
    articleHtml,
    measureSentencePositions,
    measureSummaryPositions,
    summaryWrapRef,
    articleTextRef,
  ]);

  return { sentenceMetrics, summaryMetricsState, refreshSentenceRanges, hasSettledLayout };
}
