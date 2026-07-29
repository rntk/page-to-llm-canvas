// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const sentenceHighlightMocks = vi.hoisted(() => ({
  buildSentenceDomRange: vi.fn(),
}));

vi.mock('../../highlights/sentenceHighlight.js', () => sentenceHighlightMocks);

import { useCanvasTopicNavigation } from './useCanvasTopicNavigation.js';

const cleanups = [];

function setup(overrides = {}) {
  const props = {
    showSummaryMode: false,
    setShowSummaryMode: vi.fn(),
    summaryCardRefs: { current: {} },
    summaryCards: [],
    summaryMetricsState: new Map(),
    zoomAdjustedTopicCards: [],
    selectedLevel: 0,
    selectedTopicKey: null,
    selectedTopicCardKey: null,
    setSelectedTopicKey: vi.fn(),
    setSelectedTopicCardKey: vi.fn(),
    refreshSentenceRanges: vi.fn(() => ({ wordEntries: [], sentenceRanges: new Map() })),
    // The transform hook's single imperative handle (stable identity, as in the
    // real hook) rather than six loose members.
    viewport: {
      zoomToTarget: vi.fn(),
      canvasWrapElRef: { current: { clientHeight: 600 } },
      scaleRef: { current: 2 },
      translateRef: { current: { x: 42, y: -20 } },
      setTransformNow: vi.fn(),
      userMovedCanvasRef: { current: false },
    },
    flashFocus: vi.fn(),
    navigateCanvas: vi.fn(),
    skipNextAlignment: vi.fn(),
    ...overrides,
  };

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const result = { current: null };
  let currentProps = props;

  function Harness() {
    result.current = useCanvasTopicNavigation(currentProps);
    return null;
  }

  act(() => root.render(createElement(Harness)));
  const rendered = {
    props,
    result,
    rerender(nextProps) {
      currentProps = { ...currentProps, ...nextProps };
      act(() => root.render(createElement(Harness)));
    },
    unmount() {
      act(() => root.unmount());
      host.remove();
    },
  };
  cleanups.push(rendered.unmount);
  return rendered;
}

beforeEach(() => {
  sentenceHighlightMocks.buildSentenceDomRange.mockReset();
});

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe('useCanvasTopicNavigation', () => {
  it('zooms to a descendant summary element and to an article sentence range', () => {
    const summaryRect = { top: 10, left: 20, width: 30, height: 40 };
    const articleRect = { top: 50, left: 60, width: 70, height: 80 };
    const summaryEl = { getBoundingClientRect: vi.fn(() => summaryRect) };
    const domRange = { getBoundingClientRect: vi.fn(() => articleRect) };
    sentenceHighlightMocks.buildSentenceDomRange.mockReturnValue(domRange);

    const ctx = setup({
      showSummaryMode: true,
      summaryCardRefs: { current: { 'Parent > Child#0': summaryEl } },
    });

    act(() => ctx.result.current.zoomToTopic('Parent'));
    expect(summaryEl.getBoundingClientRect).toHaveBeenCalledOnce();
    expect(ctx.props.viewport.zoomToTarget).toHaveBeenLastCalledWith(summaryRect);

    ctx.rerender({ showSummaryMode: false });
    act(() => ctx.result.current.zoomToTopic('Parent', { startSentence: 3 }));
    expect(ctx.props.refreshSentenceRanges).toHaveBeenCalledOnce();
    expect(sentenceHighlightMocks.buildSentenceDomRange).toHaveBeenCalledWith(
      expect.any(Map),
      [],
      3,
    );
    expect(ctx.props.viewport.zoomToTarget).toHaveBeenLastCalledWith(articleRect);
  });

  it('pans valid cards and ignores cards without a finite measured top', () => {
    const ctx = setup();

    act(() => ctx.result.current.panToTopic({ key: 'A#0', fullPath: 'A', top: 150 }));
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledWith(2, { x: 42, y: -180 });
    expect(ctx.props.flashFocus).toHaveBeenCalledOnce();

    ctx.rerender({ showSummaryMode: true, summaryMetricsState: new Map() });
    act(() => ctx.result.current.panToTopic({ key: 'Missing#0', path: 'Missing' }));
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledTimes(1);
    expect(ctx.props.flashFocus).toHaveBeenCalledTimes(1);
  });

  it('delegates canvas controls and applies topic navigation selection and pan', () => {
    const cards = [
      { key: 'A#0', fullPath: 'A', startSentence: 1, levelIndex: 0, top: 20 },
      { key: 'B#0', fullPath: 'B', startSentence: 2, levelIndex: 0, top: 80 },
    ];
    const ctx = setup({
      zoomAdjustedTopicCards: cards,
      selectedTopicKey: 'A',
      selectedTopicCardKey: 'A#0',
    });

    act(() => ctx.result.current.handleNavigate('left'));
    expect(ctx.props.navigateCanvas).toHaveBeenCalledWith('left');

    act(() => ctx.result.current.handleNavigate('next-topic'));
    expect(ctx.props.setSelectedTopicKey).toHaveBeenCalledWith('B');
    expect(ctx.props.setSelectedTopicCardKey).toHaveBeenCalledWith('B#0');
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledWith(2, { x: 42, y: -40 });
    expect(ctx.props.flashFocus).toHaveBeenCalledOnce();
  });

  it('queues source-sentence zoom until article mode mounts', () => {
    const articleRect = { top: 100, left: 0, width: 100, height: 20 };
    const domRange = { getBoundingClientRect: vi.fn(() => articleRect) };
    sentenceHighlightMocks.buildSentenceDomRange.mockReturnValue(domRange);
    const ctx = setup({ showSummaryMode: true });
    const card = { key: 'Topic#0', path: 'Topic', startSentence: 4 };

    act(() => ctx.result.current.handleShowSourceSentences(card));
    expect(ctx.props.skipNextAlignment).toHaveBeenCalledOnce();
    expect(ctx.props.setSelectedTopicKey).toHaveBeenCalledWith('Topic');
    expect(ctx.props.setSelectedTopicCardKey).toHaveBeenCalledWith('Topic#0');
    expect(ctx.props.setShowSummaryMode).toHaveBeenCalledWith(false);
    expect(ctx.props.viewport.zoomToTarget).not.toHaveBeenCalled();

    ctx.rerender({ showSummaryMode: false });
    expect(sentenceHighlightMocks.buildSentenceDomRange).toHaveBeenCalledWith(
      expect.any(Map),
      [],
      4,
    );
    expect(ctx.props.viewport.zoomToTarget).toHaveBeenCalledWith(articleRect);
  });
});
