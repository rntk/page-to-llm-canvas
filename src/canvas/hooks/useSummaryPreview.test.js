// @vitest-environment happy-dom
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useSummaryPreview, {
  getSummaryPreviewCacheSizes,
  SENTENCE_PREVIEW_HIDE_DELAY_MS,
  SENTENCE_PREVIEW_SHOW_DELAY_MS,
} from './useSummaryPreview.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cards = [
  { key: 'a#0#0', path: 'Intro', text: 'Intro summary', sourceSentences: [1, 2] },
  { key: 'b#0#0', path: 'Body', text: 'Body summary', sourceSentences: [3] },
  { key: 'c#0#0', path: 'Empty', text: 'No source', sourceSentences: [] },
];

const source = {
  html: '<p><span data-sentence="1">One.</span> <span data-sentence="2">Two.</span> <span data-sentence="3">Three.</span></p>',
  sentences: ['One.', 'Two.', 'Three.'],
  sourceUrl: 'https://example.com/article',
};

const cardRegistry = { get: () => null, register: () => {}, entries: () => [] };

function renderHook(overrides = {}, { strict = false } = {}) {
  const result = { current: null };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  function Probe(props) {
    result.current = useSummaryPreview(props);
    return null;
  }

  const props = {
    cards,
    activeTopic: null,
    hoveredTopic: null,
    cardRegistry,
    contentRef: { current: null },
    onTopicEnter: () => {},
    onTopicLeave: () => {},
    source,
    previewWidth: 320,
    ...overrides,
  };

  const renderProbe = (nextProps) => {
    const probe = createElement(Probe, nextProps);
    return strict ? createElement(StrictMode, null, probe) : probe;
  };

  act(() => root.render(renderProbe(props)));

  return {
    result,
    rerender: (next) => act(() => root.render(renderProbe({ ...props, ...next }))),
    unmount: () => act(() => root.unmount()),
  };
}

describe('useSummaryPreview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a hovered card preview only after the show delay', () => {
    const onTopicEnter = vi.fn();
    const { result, unmount } = renderHook({ onTopicEnter });

    act(() => result.current.showPreviewForCard(cards[0]));
    expect(onTopicEnter).not.toHaveBeenCalled();
    expect(result.current.previewCardKey).toBeNull();

    act(() => vi.advanceTimersByTime(SENTENCE_PREVIEW_SHOW_DELAY_MS));
    expect(onTopicEnter).toHaveBeenCalledWith({ path: 'Intro', cardKey: 'a#0#0' });
    expect(result.current.previewCardKey).toBe('a#0#0');
    unmount();
  });

  // A fast cursor sweep across the column must collapse to a single open, not
  // one preview build per card crossed.
  it('cancels a pending open when the cursor leaves before the delay elapses', () => {
    const onTopicEnter = vi.fn();
    const { result, unmount } = renderHook({ onTopicEnter });

    act(() => result.current.showPreviewForCard(cards[0]));
    act(() => result.current.handleSummaryCardLeave(cards[0]));
    act(() => vi.advanceTimersByTime(SENTENCE_PREVIEW_SHOW_DELAY_MS * 4));

    expect(onTopicEnter).not.toHaveBeenCalled();
    expect(result.current.previewCardKey).toBeNull();
    unmount();
  });

  it('hides an open preview only after the hide delay', () => {
    const { result, unmount } = renderHook();

    act(() => result.current.showPreviewForCard(cards[0], { immediate: true }));
    expect(result.current.previewCardKey).toBe('a#0#0');

    act(() => result.current.handleSummaryCardLeave(cards[0]));
    expect(result.current.previewCardKey).toBe('a#0#0');

    act(() => vi.advanceTimersByTime(SENTENCE_PREVIEW_HIDE_DELAY_MS));
    expect(result.current.previewCardKey).toBeNull();
    unmount();
  });

  it('locks a clicked preview open across a card leave, and toggles it off on a second click', () => {
    const onTopicEnter = vi.fn();
    const { result, unmount } = renderHook({ onTopicEnter }, { strict: true });

    act(() => result.current.handleSummaryCardClick(cards[0]));
    expect(result.current.previewCardKey).toBe('a#0#0');
    expect(onTopicEnter).toHaveBeenCalledTimes(1);

    act(() => result.current.handleSummaryCardLeave(cards[0]));
    act(() => vi.advanceTimersByTime(SENTENCE_PREVIEW_HIDE_DELAY_MS * 4));
    expect(result.current.previewCardKey).toBe('a#0#0');

    act(() => result.current.handleSummaryCardClick(cards[0]));
    expect(result.current.previewCardKey).toBeNull();
    unmount();
  });

  it('ignores clicks on cards without source sentences', () => {
    const { result, unmount } = renderHook();

    act(() => result.current.handleSummaryCardClick(cards[2]));

    expect(result.current.previewCardKey).toBeNull();
    unmount();
  });

  it('closes a locked preview on Escape and stops the event', () => {
    const { result, unmount } = renderHook();
    act(() => result.current.handleSummaryCardClick(cards[0]));

    const stopPropagation = vi.fn();
    act(() => result.current.handleSummaryCardKeyDown({ key: 'Escape', stopPropagation }));

    expect(stopPropagation).toHaveBeenCalled();
    expect(result.current.previewCardKey).toBeNull();
    unmount();
  });

  it('leaves other keys alone when nothing is locked', () => {
    const { result, unmount } = renderHook();
    act(() => result.current.showPreviewForCard(cards[0], { immediate: true }));

    const stopPropagation = vi.fn();
    act(() => result.current.handleSummaryCardKeyDown({ key: 'Escape', stopPropagation }));

    expect(stopPropagation).not.toHaveBeenCalled();
    expect(result.current.previewCardKey).toBe('a#0#0');
    unmount();
  });

  // Leaving the floating panel closes it while hovering, but a locked preview
  // stays put until it is explicitly dismissed.
  it('closes on preview leave only when the preview is not locked', () => {
    const { result, unmount } = renderHook();

    act(() => result.current.showPreviewForCard(cards[0], { immediate: true }));
    act(() => result.current.handlePreviewLeave());
    expect(result.current.previewCardKey).toBeNull();

    act(() => result.current.handleSummaryCardClick(cards[1]));
    act(() => result.current.handlePreviewLeave());
    expect(result.current.previewCardKey).toBe('b#0#0');
    unmount();
  });

  it('prefers an externally hovered topic over the locally hovered card', () => {
    const { result, rerender, unmount } = renderHook();
    act(() => result.current.handleSummaryCardClick(cards[0]));

    rerender({ hoveredTopic: { path: 'Body', cardKey: 'b#0#0' } });

    expect(result.current.previewCardKey).toBe('b#0#0');
    unmount();
  });

  it('falls back to the active topic when nothing is hovered or locked', () => {
    const { result, unmount } = renderHook({ activeTopic: { path: 'Body', cardKey: 'b#0#0' } });

    expect(result.current.previewCardKey).toBe('b#0#0');
    expect(result.current.hasActiveSummaryCardKey).toBe(true);
    unmount();
  });

  it('reports no active card key when the active topic points outside the current cards', () => {
    const { result, unmount } = renderHook({ activeTopic: { path: 'Gone', cardKey: 'z#9#9' } });

    expect(result.current.hasActiveSummaryCardKey).toBe(false);
    unmount();
  });

  it('forwards the summary element to a callback contentRef as well as an object ref', () => {
    const contentRef = vi.fn();
    const { result, unmount } = renderHook({ contentRef });
    const el = document.createElement('div');

    act(() => result.current.setSummaryViewRefs(el));

    expect(contentRef).toHaveBeenCalledWith(el);
    unmount();
  });

  // Timers outliving the component would fire setState on an unmounted tree.
  it('clears pending timers on unmount', () => {
    const onTopicEnter = vi.fn();
    const { result, unmount } = renderHook({ onTopicEnter });

    act(() => result.current.showPreviewForCard(cards[0]));
    unmount();
    act(() => vi.advanceTimersByTime(SENTENCE_PREVIEW_SHOW_DELAY_MS * 4));

    expect(onTopicEnter).not.toHaveBeenCalled();
  });

  it('releases its source-model and preview HTML caches on unmount', () => {
    const initialSizes = getSummaryPreviewCacheSizes();
    const { result, unmount } = renderHook();

    act(() => result.current.showPreviewForCard(cards[0], { immediate: true }));
    expect(getSummaryPreviewCacheSizes()).toEqual({
      previewHtml: initialSizes.previewHtml + 1,
      sourceModel: initialSizes.sourceModel + 1,
    });

    unmount();
    expect(getSummaryPreviewCacheSizes()).toEqual(initialSizes);
  });
});
