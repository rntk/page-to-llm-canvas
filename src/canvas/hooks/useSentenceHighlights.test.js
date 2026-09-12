// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useSentenceHighlights, useChatHighlights } from './useSentenceHighlights.js';
import {
  HIGHLIGHT_NAME,
  CHAT_HIGHLIGHT_NAME,
  collectWordEntries,
  buildSentenceWordRanges,
} from '../../highlights/sentenceHighlight.js';

const HIGHLIGHT_HOVER = 'pagetollm-sentence-hover';

// Minimal CSS Custom Highlight API polyfill (happy-dom ships neither Highlight
// nor CSS.highlights). Highlight just records the live Ranges added to it.
class FakeHighlight {
  constructor() {
    this.ranges = new Set();
  }
  add(range) {
    this.ranges.add(range);
  }
}

function installHighlightApi() {
  globalThis.Highlight = FakeHighlight;
  globalThis.CSS = globalThis.CSS || {};
  globalThis.CSS.highlights = new Map();
}

// Text covered by each live Range in a named highlight, so tests can assert
// which sentences were painted rather than just that something was.
function paintedText(name) {
  return Array.from(CSS.highlights.get(name)?.ranges ?? [], (range) => range.toString());
}

// Build a real article DOM so buildSentenceDomRange resolves live Ranges, then
// derive the word entries / sentence ranges refreshSentenceRanges must return.
function buildArticle(sentences) {
  const container = document.createElement('div');
  container.textContent = sentences.join(' ');
  document.body.appendChild(container);
  const wordEntries = collectWordEntries([container]);
  const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
  return {
    container,
    refresh: () => ({ wordEntries, sentenceRanges }),
  };
}

function setup(overrides = {}) {
  const { container, refresh } = buildArticle(['One two three', 'four five six']);
  const props = {
    showSummaryMode: false,
    // sentence 1 → "sel", sentence 2 → "hov".
    topicSentenceIndex: new Map([
      ['sel', [1]],
      ['hov', [2]],
      ['both', [1, 2]],
    ]),
    selectedTopicKey: null,
    hoveredTopicKey: null,
    articleHtml: '<p>x</p>',
    refreshSentenceRanges: refresh,
    ...overrides,
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  let current = props;
  function Harness() {
    useSentenceHighlights(current);
    return null;
  }
  const root = createRoot(host);
  act(() => root.render(createElement(Harness)));
  return {
    rerender(next) {
      current = { ...current, ...next };
      act(() => root.render(createElement(Harness)));
    },
    cleanup() {
      act(() => root.unmount());
      host.remove();
      container.remove();
    },
  };
}

describe('useSentenceHighlights', () => {
  beforeEach(() => installHighlightApi());
  afterEach(() => {
    delete globalThis.Highlight;
    delete globalThis.CSS.highlights;
  });

  it('paints the selected topic and clears the empty hover highlight', () => {
    const ctx = setup({ selectedTopicKey: 'sel', hoveredTopicKey: null });
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(true);
    expect(CSS.highlights.get(HIGHLIGHT_NAME).ranges.size).toBe(1);
    expect(CSS.highlights.has(HIGHLIGHT_HOVER)).toBe(false);
    ctx.cleanup();
  });

  it('paints selected and hover as separate named highlights', () => {
    const ctx = setup({ selectedTopicKey: 'sel', hoveredTopicKey: 'hov' });
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(true);
    expect(CSS.highlights.has(HIGHLIGHT_HOVER)).toBe(true);
    ctx.cleanup();
  });

  it('excludes already-selected sentences from the hover highlight', () => {
    // Hover key "both" covers sentences 1 and 2, but sentence 1 is selected, so
    // hover is left with only sentence 2's range (not double painted).
    const ctx = setup({ selectedTopicKey: 'sel', hoveredTopicKey: 'both' });
    expect(CSS.highlights.get(HIGHLIGHT_HOVER).ranges.size).toBe(1);
    ctx.cleanup();
  });

  it('deletes the hover highlight when hover fully overlaps the selection', () => {
    // Hover "sel" is entirely inside the selection → nothing left to paint.
    const ctx = setup({ selectedTopicKey: 'sel', hoveredTopicKey: 'sel' });
    expect(CSS.highlights.has(HIGHLIGHT_HOVER)).toBe(false);
    ctx.cleanup();
  });

  it('clears both highlights when nothing is selected or hovered', () => {
    const ctx = setup({ selectedTopicKey: null, hoveredTopicKey: null });
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
    expect(CSS.highlights.has(HIGHLIGHT_HOVER)).toBe(false);
    ctx.cleanup();
  });

  it('removes both highlights on cleanup/unmount', () => {
    const ctx = setup({ selectedTopicKey: 'sel', hoveredTopicKey: 'hov' });
    expect(CSS.highlights.size).toBeGreaterThan(0);
    ctx.cleanup();
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
    expect(CSS.highlights.has(HIGHLIGHT_HOVER)).toBe(false);
  });

  it('is a no-op in summary mode', () => {
    const spy = vi.spyOn(CSS.highlights, 'set');
    const ctx = setup({ showSummaryMode: true, selectedTopicKey: 'sel' });
    expect(spy).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('is a no-op when the Highlight API is unsupported', () => {
    delete globalThis.Highlight;
    const ctx = setup({ selectedTopicKey: 'sel' });
    // No throw, and no highlight registered.
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
    ctx.cleanup();
  });
});

describe('useChatHighlights', () => {
  beforeEach(() => installHighlightApi());
  afterEach(() => {
    delete globalThis.Highlight;
    delete globalThis.CSS.highlights;
  });

  function setupChat(overrides = {}) {
    const { container, refresh } = buildArticle(['One two three', 'four five six']);
    const refreshSentenceRanges = vi.fn(refresh);
    let current = {
      showSummaryMode: false,
      sentenceNumbers: [1],
      articleHtml: '<p>x</p>',
      refreshSentenceRanges,
      ...overrides,
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    function Harness() {
      useChatHighlights(current);
      return null;
    }
    const root = createRoot(host);
    act(() => root.render(createElement(Harness)));
    return {
      refreshSentenceRanges,
      rerender(next) {
        current = { ...current, ...next };
        act(() => root.render(createElement(Harness)));
      },
      cleanup() {
        act(() => root.unmount());
        host.remove();
        container.remove();
      },
    };
  }

  it('refreshes ranges, paints the requested sentences, and deletes on unmount', () => {
    const ctx = setupChat({ sentenceNumbers: [2] });
    expect(ctx.refreshSentenceRanges).toHaveBeenCalledTimes(1);
    expect(paintedText(CHAT_HIGHLIGHT_NAME)).toEqual(['four five six']);
    ctx.cleanup();
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
  });

  it('does nothing when summary mode is visible', () => {
    const ctx = setupChat({ showSummaryMode: true });
    expect(ctx.refreshSentenceRanges).not.toHaveBeenCalled();
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
    ctx.cleanup();
  });

  it('does nothing when the Highlight API is unsupported', () => {
    delete globalThis.Highlight;
    const ctx = setupChat();
    expect(ctx.refreshSentenceRanges).not.toHaveBeenCalled();
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
    ctx.cleanup();
  });

  it('cleans the active highlight when switching into summary mode', () => {
    const ctx = setupChat({ sentenceNumbers: [1] });
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(true);
    ctx.rerender({ showSummaryMode: true });
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
    ctx.cleanup();
  });

  it('cleans and repaints when article HTML changes', () => {
    const ctx = setupChat({ sentenceNumbers: [1] });
    const before = CSS.highlights.get(CHAT_HIGHLIGHT_NAME);
    expect(paintedText(CHAT_HIGHLIGHT_NAME)).toEqual(['One two three']);
    ctx.rerender({ articleHtml: '<p>Updated</p>', sentenceNumbers: [2] });
    expect(ctx.refreshSentenceRanges).toHaveBeenCalledTimes(2);
    // A fresh Highlight replaces the old one rather than accumulating ranges.
    expect(CSS.highlights.get(CHAT_HIGHLIGHT_NAME)).not.toBe(before);
    expect(paintedText(CHAT_HIGHLIGHT_NAME)).toEqual(['four five six']);
    ctx.cleanup();
  });

  it('repaints to exactly the new sentence set when it changes', () => {
    const ctx = setupChat({ sentenceNumbers: [1] });
    ctx.rerender({ sentenceNumbers: [1, 2] });
    expect(paintedText(CHAT_HIGHLIGHT_NAME)).toEqual(['One two three', 'four five six']);
    ctx.rerender({ sentenceNumbers: [] });
    expect(paintedText(CHAT_HIGHLIGHT_NAME)).toEqual([]);
    ctx.cleanup();
  });
});
