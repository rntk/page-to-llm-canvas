// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { createCardElementRegistry } from './useSummaryCardRegistry.js';
import { useSentenceMetrics } from './useSentenceMetrics.js';

const SENTENCES = ['One two three', 'four five six'];

// happy-dom Ranges report no client rects, so the measurement engine would
// find nothing to measure. Stub one laid-out line box per range.
function stubClientRects() {
  return vi
    .spyOn(Range.prototype, 'getClientRects')
    .mockReturnValue([{ top: 100, bottom: 120, left: 0, right: 50, width: 50, height: 20 }]);
}

function makeArticle() {
  const article = document.createElement('div');
  article.textContent = SENTENCES.join(' ');
  document.body.appendChild(article);
  return article;
}

function makeWrap() {
  const wrap = document.createElement('div');
  wrap.getBoundingClientRect = () => ({ top: 0, left: 0, width: 200, height: 400 });
  document.body.appendChild(wrap);
  return wrap;
}

function setup(overrides = {}) {
  // Manual rAF queue so the triple-rAF schedule is drained on demand.
  const origRaf = window.requestAnimationFrame;
  const origCancel = window.cancelAnimationFrame;
  const queue = new Map();
  let id = 0;
  window.requestAnimationFrame = (cb) => {
    id += 1;
    queue.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (rid) => queue.delete(rid);
  const flushRafs = () => {
    for (let i = 0; i < 12 && queue.size; i++) {
      const cbs = [...queue.values()];
      queue.clear();
      act(() => cbs.forEach((cb) => cb()));
    }
  };

  const article = makeArticle();
  const wrap = makeWrap();
  const props = {
    articleTextRef: { current: article },
    summaryWrapRef: { current: wrap },
    summaryCardRegistry: createCardElementRegistry({ current: {} }),
    scaleRef: { current: 1 },
    showSummaryMode: false,
    isZoomingToTarget: false,
    sentences: SENTENCES,
    summaryCards: [],
    articleHtml: '<p>x</p>',
    ...overrides,
  };

  const host = document.createElement('div');
  document.body.appendChild(host);
  const result = { current: null };
  let current = props;
  function Harness() {
    result.current = useSentenceMetrics(current);
    return null;
  }
  const root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  return {
    result,
    article,
    wrap,
    props,
    flushRafs,
    rerender(next) {
      current = { ...current, ...next };
      act(() => root.render(createElement(Harness)));
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
      article.remove();
      wrap.remove();
      window.requestAnimationFrame = origRaf;
      window.cancelAnimationFrame = origCancel;
    },
  };
}

describe('useSentenceMetrics', () => {
  let rectsSpy;
  beforeEach(() => {
    rectsSpy = stubClientRects();
  });
  afterEach(() => {
    rectsSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it('refreshSentenceRanges returns the cached refs when the article is absent', () => {
    const ctx = setup({ articleTextRef: { current: null } });
    const out = ctx.result.current.refreshSentenceRanges();
    expect(out.wordEntries).toEqual([]);
    expect(out.sentenceRanges instanceof Map).toBe(true);
    expect(out.sentenceRanges.size).toBe(0);
    ctx.cleanup();
  });

  it('measures sentence positions in wrap-local, scale-independent px', () => {
    const ctx = setup();
    ctx.flushRafs();
    const metrics = ctx.result.current.sentenceMetrics;
    expect(metrics.size).toBe(SENTENCES.length);
    // top = (rect.top - wrapTop) / scale = (100 - 0) / 1.
    expect(metrics.get(1)).toEqual({ top: 100, bottom: 120 });
    ctx.cleanup();
  });

  it('divides settled rects by the current scale', () => {
    const ctx = setup({ scaleRef: { current: 2 } });
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.get(1)).toEqual({ top: 50, bottom: 60 });
    ctx.cleanup();
  });

  it('skips sentence measurement while zooming to a target', () => {
    const ctx = setup({ isZoomingToTarget: true });
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.size).toBe(0);
    ctx.cleanup();
  });

  it('bails the state update when re-measured geometry is unchanged', () => {
    const ctx = setup();
    ctx.flushRafs();
    const first = ctx.result.current.sentenceMetrics;
    expect(first.size).toBe(SENTENCES.length);
    // A resize re-runs the schedule; identical rects must not swap the map.
    act(() => window.dispatchEvent(new Event('resize')));
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics).toBe(first);
    ctx.cleanup();
  });

  it('measures summary card geometry in summary mode', () => {
    const card = document.createElement('div');
    card.getBoundingClientRect = () => ({ top: 40, left: 0, width: 100, height: 60 });
    document.body.appendChild(card);
    const ctx = setup({
      showSummaryMode: true,
      summaryCardRegistry: createCardElementRegistry({
        current: { 'topic/a': card, 'topic/missing': null },
      }),
    });
    ctx.flushRafs();
    const summary = ctx.result.current.summaryMetricsState;
    expect(summary.get('topic/a')).toEqual({ top: 40, height: 60 });
    // No sentence metrics are taken in summary mode.
    expect(ctx.result.current.sentenceMetrics.size).toBe(0);
    card.remove();
    ctx.cleanup();
  });

  it('re-measures sentences when leaving summary mode', () => {
    const ctx = setup({ showSummaryMode: true });
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.size).toBe(0);
    // Exiting summary mode schedules a post-paint remeasure of the article.
    ctx.rerender({ showSummaryMode: false });
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.size).toBe(SENTENCES.length);
    ctx.cleanup();
  });

  it('reschedules measurement when a pending image finishes loading', () => {
    const article = makeArticle();
    const img = document.createElement('img');
    Object.defineProperty(img, 'complete', { value: false, configurable: true });
    article.appendChild(img);
    const addSpy = vi.spyOn(img, 'addEventListener');
    const ctx = setup({ articleTextRef: { current: article } });
    ctx.flushRafs();
    // The load/error listeners were wired for the still-loading image.
    expect(addSpy).toHaveBeenCalledWith('load', expect.any(Function));
    act(() => img.dispatchEvent(new Event('load')));
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.size).toBe(SENTENCES.length);
    ctx.cleanup();
    article.remove();
  });

  it('reschedules once web fonts become ready', async () => {
    const readyPromise = Promise.resolve();
    Object.defineProperty(document, 'fonts', {
      value: { ready: readyPromise },
      configurable: true,
    });
    const ctx = setup();
    await act(async () => {
      await readyPromise;
    });
    ctx.flushRafs();
    expect(ctx.result.current.sentenceMetrics.size).toBe(SENTENCES.length);
    ctx.cleanup();
    delete document.fonts;
  });
});
