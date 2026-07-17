// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const highlightApi = vi.hoisted(() => ({
  supportsHighlightApi: vi.fn(),
  paintSentenceHighlight: vi.fn(),
}));

vi.mock('../highlights/sentenceHighlight.js', () => ({
  CHAT_HIGHLIGHT_NAME: 'pagetollm-chat-sentence',
  supportsHighlightApi: highlightApi.supportsHighlightApi,
  paintSentenceHighlight: highlightApi.paintSentenceHighlight,
}));

import { CHAT_HIGHLIGHT_NAME, useChatHighlights } from './useChatHighlights.js';

const cleanups = [];

function setup(overrides = {}) {
  const rangeData = {
    wordEntries: [{ word: 'One' }],
    sentenceRanges: new Map([[1, { startIdx: 0, endIdx: 0 }]]),
  };
  const refreshSentenceRanges = vi.fn(() => rangeData);
  let props = {
    isDone: true,
    showSummaryMode: false,
    sentenceNumbers: [1, 3],
    articleHtml: '<p>One</p>',
    refreshSentenceRanges,
    ...overrides,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Harness() {
    useChatHighlights(props);
    return null;
  }

  act(() => root.render(createElement(Harness)));

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(cleanup);

  return {
    rangeData,
    refreshSentenceRanges,
    rerender(nextProps) {
      props = { ...props, ...nextProps };
      act(() => root.render(createElement(Harness)));
    },
    cleanup,
  };
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  highlightApi.supportsHighlightApi.mockReturnValue(true);
  vi.stubGlobal('CSS', { highlights: { delete: vi.fn() } });
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  vi.unstubAllGlobals();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('useChatHighlights', () => {
  it('refreshes ranges, paints the chat highlight, and deletes it on unmount', () => {
    const sentenceNumbers = [1, 3];
    const ctx = setup({ sentenceNumbers });

    expect(ctx.refreshSentenceRanges).toHaveBeenCalledTimes(1);
    expect(highlightApi.paintSentenceHighlight).toHaveBeenCalledWith(
      CHAT_HIGHLIGHT_NAME,
      sentenceNumbers,
      ctx.rangeData,
    );
    expect(CSS.highlights.delete).not.toHaveBeenCalled();

    ctx.cleanup();
    expect(CSS.highlights.delete).toHaveBeenCalledWith(CHAT_HIGHLIGHT_NAME);
  });

  it.each([
    ['the article is not done', { isDone: false }, true],
    ['summary mode is visible', { showSummaryMode: true }, true],
    ['the Highlight API is unavailable', {}, false],
  ])('does nothing when %s', (_label, overrides, supportsApi) => {
    highlightApi.supportsHighlightApi.mockReturnValue(supportsApi);
    const ctx = setup(overrides);

    expect(ctx.refreshSentenceRanges).not.toHaveBeenCalled();
    expect(highlightApi.paintSentenceHighlight).not.toHaveBeenCalled();
    ctx.cleanup();
    expect(CSS.highlights.delete).not.toHaveBeenCalled();
  });

  it('cleans the active highlight when switching into summary mode', () => {
    const ctx = setup();

    ctx.rerender({ showSummaryMode: true });

    expect(CSS.highlights.delete).toHaveBeenCalledTimes(1);
    expect(CSS.highlights.delete).toHaveBeenCalledWith(CHAT_HIGHLIGHT_NAME);
    expect(ctx.refreshSentenceRanges).toHaveBeenCalledTimes(1);
    expect(highlightApi.paintSentenceHighlight).toHaveBeenCalledTimes(1);
  });

  it('cleans and repaints when article HTML changes', () => {
    const ctx = setup();

    ctx.rerender({ articleHtml: '<p>Updated</p>' });

    expect(CSS.highlights.delete).toHaveBeenCalledTimes(1);
    expect(ctx.refreshSentenceRanges).toHaveBeenCalledTimes(2);
    expect(highlightApi.paintSentenceHighlight).toHaveBeenCalledTimes(2);
    expect(highlightApi.paintSentenceHighlight).toHaveBeenLastCalledWith(
      CHAT_HIGHLIGHT_NAME,
      expect.any(Array),
      ctx.rangeData,
    );
  });
});
