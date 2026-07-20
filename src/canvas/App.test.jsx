// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  record: null,
  error: null,
  vm: {},
  childProps: {},
}));

const mocks = vi.hoisted(() => ({
  setTransformNow: vi.fn(),
  navigateCanvas: vi.fn(),
  zoomToTarget: vi.fn(),
  flashFocus: vi.fn(),
  handleMouseDown: vi.fn(),
  captureAnchor: vi.fn(),
  skipNextAlignment: vi.fn(),
  refreshSentenceRanges: vi.fn(() => ({ wordEntries: [], sentenceRanges: new Map() })),
  buildSentenceDomRange: vi.fn(),
  retryRecord: vi.fn(() => Promise.resolve()),
  resolveSummaryErrors: vi.fn(() => Promise.resolve()),
  closeModal: vi.fn(),
  toggleTopicSelection: vi.fn(),
  clearTopicSelection: vi.fn(),
  setSelectedLevel: vi.fn(),
  setSelectedTopicKey: vi.fn(),
  setSelectedTopicCardKey: vi.fn(),
  zoomToTopic: vi.fn(),
  panToTopic: vi.fn(),
  handleNavigate: vi.fn(),
  handleShowSourceSentences: vi.fn(),
}));

vi.mock('./hooks/useRecord.js', () => ({
  useRecord: () => ({ record: state.record, error: state.error }),
}));

vi.mock('../domain/topicCards.js', () => ({
  COLUMN_GAP: 10,
  RAIL_PADDING: 10,
  buildTopicCards: vi.fn(() => [{ key: 'Topic#0', path: 'Topic', levelIndex: 0, height: 20 }]),
  patchTopicCardsFromSummaryMetrics: vi.fn((cards) => cards),
  getTopicTitleFontSize: vi.fn(() => 12),
  getZoomAdjustedCardWidth: vi.fn(() => 100),
  getZoomAdjustedSummaryCardWidth: vi.fn(() => 220),
}));

function captureComponent(name) {
  return (props) => {
    state.childProps[name] = props;
    return null;
  };
}

vi.mock('./components/CanvasTopicHierarchyRail.jsx', () => ({
  default: captureComponent('rail'),
}));
vi.mock('./components/CanvasSummaryView.jsx', () => ({
  default: captureComponent('summary'),
}));
vi.mock('./components/CanvasZoomControls.jsx', () => ({
  default: captureComponent('controls'),
}));
vi.mock('./components/SpinnerOverlay.jsx', () => ({ default: captureComponent('spinner') }));
vi.mock('../components/SummaryErrorsOverlay.jsx', () => ({
  default: captureComponent('summaryErrors'),
}));
vi.mock('./components/ArticleHtml.jsx', () => ({ default: captureComponent('article') }));
vi.mock('../chat/ArticleChat.jsx', () => ({ default: captureComponent('chat') }));

vi.mock('./closeModal.js', () => ({ closeModal: mocks.closeModal }));
vi.mock('../utils/canvasMath.js', () => ({
  clampScale: (value) => Math.max(0.1, Math.min(4, value)),
}));
vi.mock('./hooks/useCanvasTransform.js', () => ({
  useCanvasTransform: () => ({
    scale: 1,
    isCanvasDragging: false,
    isFocusingHighlight: false,
    isZoomingToTarget: false,
    canvasWrapRef: { current: null },
    canvasViewportRef: { current: null },
    canvasWrapElRef: { current: { focus: vi.fn(), clientHeight: 500 } },
    scaleRef: { current: 1 },
    translateRef: { current: { x: 3, y: 4 } },
    userMovedCanvasRef: { current: false },
    handleMouseDown: mocks.handleMouseDown,
    setTransformNow: mocks.setTransformNow,
    navigateCanvas: mocks.navigateCanvas,
    zoomToTarget: mocks.zoomToTarget,
    flashFocus: mocks.flashFocus,
  }),
}));
vi.mock('./hooks/useCanvasAlignment.js', () => ({
  useCanvasAlignment: () => ({
    captureAnchor: mocks.captureAnchor,
    skipNextAlignment: mocks.skipNextAlignment,
  }),
}));
vi.mock('./hooks/useSentenceMetrics.js', () => ({
  useSentenceMetrics: () => ({
    sentenceMetrics: new Map(),
    summaryMetricsState: new Map(),
    refreshSentenceRanges: mocks.refreshSentenceRanges,
  }),
}));
vi.mock('./hooks/useSentenceHighlights.js', () => ({ useSentenceHighlights: vi.fn() }));
vi.mock('../chat/useChatHighlights.js', () => ({ useChatHighlights: vi.fn() }));
vi.mock('./hooks/useInitialView.js', () => ({ useInitialView: vi.fn() }));
vi.mock('./hooks/useCanvasRecordViewModel.js', () => ({
  useCanvasRecordViewModel: () => state.vm,
}));
vi.mock('./hooks/useCanvasTopicNavigation.js', () => ({
  useCanvasTopicNavigation: () => ({
    zoomToTopic: mocks.zoomToTopic,
    panToTopic: mocks.panToTopic,
    handleNavigate: mocks.handleNavigate,
    handleShowSourceSentences: mocks.handleShowSourceSentences,
  }),
}));
vi.mock('./hooks/useTopicSelection.js', () => ({
  useTopicSelection: () => ({
    selectedTopicKey: 'Topic',
    selectedTopicCardKey: 'Topic#0',
    hoveredTopicKey: null,
    hoveredTopicCardKey: null,
    selectedLevel: 0,
    activeTopicKey: 'Topic',
    activeTopicCardKey: 'Topic#0',
    setSelectedTopicKey: mocks.setSelectedTopicKey,
    setSelectedTopicCardKey: mocks.setSelectedTopicCardKey,
    setHoveredTopicKey: vi.fn(),
    setHoveredTopicCardKey: vi.fn(),
    setSelectedLevel: mocks.setSelectedLevel,
    handleTopicEnter: vi.fn(),
    handleTopicLeave: vi.fn(),
    toggleTopicSelection: mocks.toggleTopicSelection,
    clearTopicSelection: mocks.clearTopicSelection,
  }),
}));
vi.mock('../utils/errorUtils.js', () => ({
  retryRecord: mocks.retryRecord,
  resolveSummaryErrors: mocks.resolveSummaryErrors,
}));
vi.mock('../utils/currentTopicSummary.js', () => ({
  selectCurrentTopicSummary: vi.fn(() => ({ key: 'Topic#0', text: 'Summary' })),
}));
vi.mock('../highlights/sentenceHighlight.js', () => ({
  buildSentenceDomRange: mocks.buildSentenceDomRange,
}));

import App from './App.jsx';

const doneView = {
  topics: [{ label: ['Topic'], ranges: [{ start: 0, end: 0 }] }],
  topicSentenceIndex: new Map(),
  sentences: ['Sentence one.'],
  articleHtml: '<p>Sentence one.</p>',
  maxLevel: 1,
  allSummaryCards: [{ key: 'Topic#0', path: 'Topic', startSentence: 1 }],
  summaryCards: [{ key: 'Topic#0', path: 'Topic', startSentence: 1 }],
  isDone: true,
  summariesDisabled: false,
  showSummaryMode: false,
  isNeedsAttention: false,
  isRecordError: false,
  isMissing: false,
  isDeleted: false,
  stage: 'done',
};

async function renderApp(initialKey = 'record-1') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<App initialKey={initialKey} />));
  return { container, root };
}

describe('App composition behavior', () => {
  beforeEach(() => {
    state.record = { key: 'record-1', sourceUrl: 'https://example.com', summaryErrors: [] };
    state.error = null;
    state.vm = { ...doneView };
    state.childProps = {};
    vi.clearAllMocks();
    mocks.refreshSentenceRanges.mockReturnValue({ wordEntries: [], sentenceRanges: new Map() });
    mocks.buildSentenceDomRange.mockReturnValue(null);
    vi.stubGlobal('chrome', {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((_message, callback) => callback({ ok: true })),
      },
    });
    vi.spyOn(window, 'focus').mockImplementation(() => {});
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders terminal and loading states and delegates their recovery actions', async () => {
    state.vm = {
      ...doneView,
      isDone: false,
      isRecordError: true,
      stage: 'error',
    };
    const errorRender = await renderApp();
    expect(state.childProps.spinner.recordError).toBe('');
    await act(async () => state.childProps.spinner.onRetry());
    expect(mocks.retryRecord).toHaveBeenCalledWith('record-1', 'Canvas');
    await act(async () => errorRender.root.unmount());

    state.vm = { ...doneView, isDone: false, isNeedsAttention: true, stage: 'needs_attention' };
    const attentionRender = await renderApp();
    await act(async () => state.childProps.summaryErrors.onRetry());
    await act(async () => state.childProps.summaryErrors.onSkip());
    expect(mocks.resolveSummaryErrors).toHaveBeenCalledWith('record-1', 'retry', 'Canvas');
    expect(mocks.resolveSummaryErrors).toHaveBeenCalledWith('record-1', 'skip', 'Canvas');
    await act(async () => attentionRender.root.unmount());
  });

  it('wires the completed canvas controls and topic interactions', async () => {
    const { container, root } = await renderApp();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      { type: 'ensurePipeline', key: 'record-1' },
      expect.any(Function),
    );
    expect(state.childProps.article.html).toBe(doneView.articleHtml);
    expect(state.childProps.rail.currentTopicSummary).toEqual(
      expect.objectContaining({ text: 'Summary' }),
    );

    await act(async () => state.childProps.controls.onZoomIn());
    await act(async () => state.childProps.controls.onZoomOut());
    await act(async () => state.childProps.controls.onReset());
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(1, 1.2, { x: 3, y: 4 });
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(2, 1 / 1.2, { x: 3, y: 4 });
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(3, 1, { x: 40, y: 40 });

    await act(async () => state.childProps.controls.onToggleSummaryMode());
    await act(async () => state.childProps.controls.onToggleTopicHierarchy());
    await act(async () => state.childProps.controls.onLevelChange(0));
    await act(async () => state.childProps.controls.onLevelChange(1));
    expect(mocks.captureAnchor).toHaveBeenCalledWith(true);
    expect(mocks.captureAnchor).toHaveBeenCalledWith(false);
    expect(mocks.setSelectedLevel).toHaveBeenCalledWith(1);

    state.childProps.rail.onTopicClick('Topic', { key: 'Topic#0' });
    expect(mocks.toggleTopicSelection).toHaveBeenCalled();
    expect(mocks.zoomToTopic).toHaveBeenCalled();

    container
      .querySelector('.canvas-area')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(mocks.handleMouseDown).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('paints chat highlights but only focuses a deliberately selected event', async () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    mocks.buildSentenceDomRange.mockReturnValue({ getBoundingClientRect: () => rect });
    const { root } = await renderApp();

    await act(async () => state.childProps.controls.onToggleChat());
    expect(state.childProps.chat.recordKey).toBe('record-1');
    await act(async () => state.childProps.chat.onHighlight({ startLine: 1, endLine: 2 }));
    expect(mocks.zoomToTarget).not.toHaveBeenCalled();
    await act(async () =>
      state.childProps.chat.onHighlight({ startLine: 1, endLine: 2 }, { focus: true }),
    );
    expect(mocks.zoomToTarget).toHaveBeenCalledWith(rect);
    await act(async () => state.childProps.chat.onClearHighlights());
    await act(async () => state.childProps.chat.onClose());
    expect(state.childProps.chat).toBeDefined();
    await act(async () => root.unmount());
  });

  it('requests pipeline ownership and tolerates empty keys and failed responses', async () => {
    chrome.runtime.sendMessage.mockImplementationOnce((_message, callback) =>
      callback({ ok: false, error: 'not ready' }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failed = await renderApp();
    expect(warn).toHaveBeenCalledWith('PageToLLM Canvas ensurePipeline failed:', 'not ready');
    await act(async () => failed.root.unmount());

    chrome.runtime.sendMessage.mockClear();
    const empty = await renderApp('');
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    await act(async () => empty.root.unmount());
  });

  it('suppresses summary-only behavior when summaries are disabled', async () => {
    state.vm = { ...doneView, summariesDisabled: true };
    const { root } = await renderApp();
    expect(state.childProps.rail.currentTopicSummary).toBeNull();
    expect(state.childProps.controls.summaryModeAvailable).toBe(false);
    await act(async () => state.childProps.controls.onToggleSummaryMode());
    expect(mocks.captureAnchor).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
