import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../../highlights/sentenceHighlight.js';
import { ENTRANCE_SETTLE_MS } from '../../utils/cardEntrance.js';

// Measurement stops as soon as two consecutive passes agree. The cap bounds the
// retries when a layout never settles (a background animation, a never-loading
// image) so measurement can never spin once per frame forever.
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
 * Owns the live DOM Ranges over the rendered article, the measured sentence and
 * summary-card geometry (in scale-independent, wrap-local px), and the layout
 * effects that keep both fresh across mode/level switches, resize, and late
 * image/font loads. The topic-hierarchy rail is positioned from the maps this
 * hook returns; the highlight hook shares its `refreshSentenceRanges`.
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

  // Topic-card positions in summary mode are derived from the rendered
  // summary cards' bounding rects (measured by an effect below).
  const [summaryMetricsState, setSummaryMetricsState] = useState(() => new Map());
  const summaryMetricsRef = useRef(summaryMetricsState);

  // "The first measurement run has converged (or hit its pass cap)", and
  // nothing more: this is the opening reveal's gate, not a live is-the-layout-
  // settled flag. It latches on the first settle and stays true for the rest of
  // the component's life — a late re-measurement (a slow image) or a later
  // summary-mode switch must not pull the curtain back down.
  const [hasSettledLayout, setHasSettledLayout] = useState(false);
  const hasSettledLayoutRef = useRef(false);

  const wordEntriesRef = useRef([]);
  const sentenceRangesRef = useRef(new Map());

  // Identity of the article DOM the cached walk below was built from.
  const rangeCacheRef = useRef({ el: null, html: null, sentences: null });

  // Rebuild word entries + sentence ranges from the *current* article DOM.
  // The Highlight API and measurement hold live Ranges into text nodes; if those
  // nodes are ever replaced by a re-render, the stale Ranges resolve to nothing
  // (getClientRects() returns empty). Rebuilding on demand keeps them pinned to
  // the live, laid-out nodes.
  //
  // The walk is the expensive half of measurement on a long article — it visits
  // every text node and reads computed styles — and callers ask for ranges
  // several times per layout pass, so the result is cached against the inputs
  // that can invalidate it: the container element, the HTML rendered into it,
  // and the sentence list. None of those change when the canvas merely pans,
  // zooms, or re-highlights: highlighting goes through the Highlight API and
  // never touches the article's nodes. The liveness probe covers the remaining
  // case — a re-render that swapped the text nodes underneath an unchanged
  // container, which would leave every cached Range resolving to nothing.
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

  // Re-build word entries and sentence ranges synchronously before paint whenever layout changes.
  useLayoutEffect(() => {
    if (showSummaryMode) return;
    refreshSentenceRanges();
  }, [showSummaryMode, articleHtml, refreshSentenceRanges]);

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
    if (!wrap || showSummaryMode || isZoomingToTarget) return null;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    if (!sentenceRanges.size) return sentences.length === 0;

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
    // Nothing has a laid-out rect yet (the article was only just injected):
    // report "not settled" so the caller schedules another pass instead of
    // treating the synthetic fallback layout as final.
    if (nextMetrics.size === 0) return sentences.length === 0;
    if (areSentenceMetricsEqual(sentenceMetricsRef.current, nextMetrics)) return true;
    sentenceMetricsRef.current = nextMetrics;
    setSentenceMetrics(nextMetrics);
    return false;
  }, [
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
    // Cards mount a render before they register their elements, so an empty
    // read while cards are expected means "too early", not "settled and empty".
    if (next.size === 0 && summaryCards.length > 0) return false;
    // The convergence schedule calls this more than once per layout pass; bail
    // the render when geometry is unchanged so we don't thrash the rail.
    if (areSummaryMetricsEqual(summaryMetricsRef.current, next)) return true;
    summaryMetricsRef.current = next;
    setSummaryMetricsState(next);
    return false;
  }, [summaryWrapRef, summaryCardRegistry, scaleRef, showSummaryMode, summaryCards]);

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
    let raf = 0;
    let passes = 0;

    // One measurement pass. "Settled" means every applicable measurement read
    // back the geometry it already had, i.e. the layout stopped moving.
    const measure = () => {
      const sentenceResult = measureSentencePositions();
      const summaryResult = measureSummaryPositions();
      const results = [sentenceResult, summaryResult].filter((result) => result !== null);
      // Nothing was applicable — article mode mid-zoom-to-target, where sentence
      // measurement is suppressed and there is no summary column. Before the
      // first settle that means "keep trying" (the zoom may be what is holding
      // the opening view up); afterwards it means "nothing to do", and retrying
      // would burn the full pass budget on every zoom the user triggers.
      if (results.length === 0) return hasSettledLayoutRef.current;
      return results.every(Boolean);
    };

    const markSettled = () => {
      if (hasSettledLayoutRef.current) return;
      hasSettledLayoutRef.current = true;
      setHasSettledLayout(true);
    };

    // Measure on layout changes (incl. summary<->article switches) until two
    // consecutive frames agree: the injected article (or the summary column)
    // needs a frame or more to lay out, and sampling too early sees no client
    // rects, which would leave topic cards stuck in the small synthetic fallback
    // layout. This replaces a fixed triple-rAF: a settled layout now costs two
    // passes instead of three, an unsettled one gets up to MAX_MEASURE_PASSES,
    // and convergence — rather than a frame count — is what tells the opening
    // overlay the cards have stopped moving.
    //
    // The in-flight frame is tracked so cleanup can cancel it: without that, a
    // queued pass can still run after a mode switch or unmount, measuring the
    // wrong DOM through stale showSummaryMode / measure* closures.
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
    // Summary cards mount with a staggered appear animation, and its
    // `translateY` is part of every card's bounding rect — measuring mid-flight
    // stores each card ~8px below where it lands, which offsets the rail cards
    // pinned to them. An animation ending changes no box size, so neither the
    // ResizeObserver nor any other signal here fires for it: schedule one pass
    // past the last card's animation instead. Article mode has no such
    // animation, so it pays nothing.
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
