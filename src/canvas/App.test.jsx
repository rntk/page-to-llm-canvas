// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const state = vi.hoisted(() => ({
  record: null,
  error: null,
  vm: {},
  vmInput: null,
  canvasWrapElement: null,
  childProps: {},
  // Gate for the opening overlay; tests flip it to inspect the covered state.
  hasSettledLayout: true,
}));

const mocks = vi.hoisted(() => ({
  setTransformNow: vi.fn(),
  navigateCanvas: vi.fn(),
  zoomToTarget: vi.fn(),
  flashFocus: vi.fn(),
  handleMouseDown: vi.fn(),
  canvasFocus: vi.fn(),
  captureAnchor: vi.fn(),
  skipNextAlignment: vi.fn(),
  refreshSentenceRanges: vi.fn(() => ({ wordEntries: [], sentenceRanges: new Map() })),
  buildSentenceDomRange: vi.fn(),
  toggleTopic: vi.fn(),
  clearSelection: vi.fn(),
  selectTopic: vi.fn(),
  setSelectedLevel: vi.fn(),
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
vi.mock('./components/CanvasToolbar.jsx', () => ({
  default: captureComponent('controls'),
}));
vi.mock('./components/ArticleHtml.jsx', () => ({ default: captureComponent('article') }));
vi.mock('../chat/ArticleChat.jsx', () => ({ default: captureComponent('chat') }));

vi.mock('../utils/canvasMath.js', () => ({
  clampScale: (value) => Math.max(0.1, Math.min(4, value)),
}));
// The real hook memoizes `viewport` to a stable identity, so the mock keeps one
// object across renders too — App uses it as an effect dependency, and a fresh
// object per render would re-run those effects on every render.
const viewportMock = vi.hoisted(() => ({
  // Read through to `state` so tests can swap the wrap element per case.
  canvasWrapElRef: {
    get current() {
      return state.canvasWrapElement;
    },
  },
  scaleRef: { current: 1 },
  translateRef: { current: { x: 3, y: 4 } },
  userMovedCanvasRef: { current: false },
  setTransformNow: mocks.setTransformNow,
  zoomToTarget: mocks.zoomToTarget,
}));

vi.mock('./hooks/useCanvasTransform.js', () => ({
  useCanvasTransform: () => ({
    scale: 1,
    isCanvasDragging: false,
    isFocusingHighlight: false,
    isZoomingToTarget: false,
    canvasWrapRef: { current: null },
    canvasViewportRef: { current: null },
    handleMouseDown: mocks.handleMouseDown,
    navigateCanvas: mocks.navigateCanvas,
    flashFocus: mocks.flashFocus,
    viewport: viewportMock,
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
    hasSettledLayout: state.hasSettledLayout,
  }),
}));
vi.mock('./hooks/useSentenceHighlights.js', () => ({ useSentenceHighlights: vi.fn() }));
vi.mock('../chat/useChatHighlights.js', () => ({ useChatHighlights: vi.fn() }));
// Stubbed out; App only reads the settled flag it returns (the opening overlay
// gate), so report the sequence as already finished.
vi.mock('./hooks/useInitialView.js', () => ({
  useInitialView: vi.fn(() => ({ isSettled: true })),
}));
vi.mock('./hooks/useCanvasRecordViewModel.js', () => ({
  useCanvasRecordViewModel: (input) => {
    state.vmInput = input;
    return state.vm;
  },
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
    selectedTarget: { path: 'Topic', cardKey: 'Topic#0' },
    hoveredTarget: null,
    activeTarget: { path: 'Topic', cardKey: 'Topic#0' },
    selectedLevel: 0,
    setSelectedLevel: mocks.setSelectedLevel,
    enterTopic: vi.fn(),
    leaveTopic: vi.fn(),
    toggleTopic: mocks.toggleTopic,
    selectTopic: mocks.selectTopic,
    clearSelection: mocks.clearSelection,
  }),
}));
vi.mock('../domain/currentTopicSummary.js', () => ({
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
  summariesDisabled: false,
  showSummaryMode: false,
};

async function renderApp(initialKey = 'record-1', props = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(<App initialKey={initialKey} {...props} />));
  return { container, root };
}

describe('App composition behavior', () => {
  it('covers the canvas with the opening overlay without unmounting anything', async () => {
    // The gate has to be purely visual: measurement runs off getClientRects, so
    // unmounting (or display:none-ing) the article while waiting would starve
    // the very measurement the overlay is waiting for.
    state.hasSettledLayout = false;
    const { container, root } = await renderApp();
    const overlay = container.querySelector('.canvas-startup');
    expect(overlay).toBeTruthy();
    expect(overlay.className).not.toContain('is-leaving');
    expect(container.querySelector('.canvas-viewport')).toBeTruthy();
    expect(state.childProps.article).toBeTruthy();
    expect(state.childProps.rail).toBeTruthy();
    await act(async () => root.unmount());
    container.remove();
  });

  it('reveals the canvas once measurement and the opening view have settled', async () => {
    const { container, root } = await renderApp();
    // Revealed on mount: the overlay is only still in the tree to fade out over
    // the live canvas, and the rail plays its entrance.
    const overlay = container.querySelector('.canvas-startup');
    expect(overlay.className).toContain('is-leaving');
    expect(state.childProps.rail.isEntering).toBe(true);
    await act(async () => root.unmount());
    container.remove();
  });

  beforeEach(() => {
    state.record = {
      key: 'record-1',
      status: 'done',
      sourceUrl: 'https://example.com',
    };
    state.error = null;
    state.vm = { ...doneView };
    state.vmInput = null;
    state.canvasWrapElement = { focus: mocks.canvasFocus, clientHeight: 500 };
    state.childProps = {};
    state.hasSettledLayout = true;
    // The shared viewport handle is stateful across tests now that it is a single
    // stable object; reset the members App writes to.
    viewportMock.scaleRef.current = 1;
    viewportMock.translateRef.current = { x: 3, y: 4 };
    viewportMock.userMovedCanvasRef.current = false;
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

  it.each(['pending', 'summarizing', 'needs_attention', 'error', 'cancelled'])(
    'does not mount Canvas for a %s record',
    async (status) => {
      state.record = { key: 'record-1', status };
      const { container, root } = await renderApp();

      expect(container.childElementCount).toBe(0);
      expect(state.vmInput).toBeNull();
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();

      await act(async () => root.unmount());
    },
  );

  it('wires the completed canvas controls and topic interactions', async () => {
    const onClose = vi.fn();
    const { container, root } = await renderApp('record-1', { onClose });
    expect(state.vmInput.showSummaryModeRaw).toBe(false);
    expect(state.childProps.controls.showSummaryMode).toBe(false);
    expect(state.childProps.controls.showTopicHierarchy).toBe(true);
    expect(state.childProps.controls.showChat).toBe(false);
    // ArticleChat stays mounted (via Activity) even while hidden, so its local
    // state (draft input, tab, scroll position) survives toggling the panel.
    expect(state.childProps.chat).toBeDefined();
    expect(state.childProps.chat.recordKey).toBe('record-1');
    expect(mocks.canvasFocus).toHaveBeenCalledWith({ preventScroll: true });
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
    expect(state.childProps.article.html).toBe(doneView.articleHtml);
    expect(state.childProps.rail.currentTopicSummary).toEqual(
      expect.objectContaining({ text: 'Summary' }),
    );
    expect(state.childProps.controls.onClose).toBe(onClose);

    await act(async () => state.childProps.controls.onZoomIn());
    await act(async () => state.childProps.controls.onZoomOut());
    await act(async () => state.childProps.controls.onReset());
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(1, 1.2, { x: 3, y: 4 });
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(2, 1 / 1.2, { x: 3, y: 4 });
    expect(mocks.setTransformNow).toHaveBeenNthCalledWith(3, 1, { x: 40, y: 40 });

    await act(async () => state.childProps.controls.onToggleSummaryMode());
    expect(state.vmInput.showSummaryModeRaw).toBe(true);
    await act(async () => state.childProps.controls.onToggleTopicHierarchy());
    expect(state.childProps.controls.showTopicHierarchy).toBe(false);
    await act(async () => state.childProps.controls.onLevelChange(0));
    await act(async () => state.childProps.controls.onLevelChange(1));
    expect(mocks.captureAnchor).toHaveBeenCalledWith(true);
    expect(mocks.captureAnchor).toHaveBeenCalledWith(false);
    expect(mocks.setSelectedLevel).toHaveBeenCalledWith(1);

    state.childProps.rail.onTopicClick({ path: 'Topic', cardKey: 'Topic#0' }, { key: 'Topic#0' });
    expect(mocks.toggleTopic).toHaveBeenCalledWith({ path: 'Topic', cardKey: 'Topic#0' });
    expect(mocks.zoomToTopic).toHaveBeenCalled();

    const focusCallsBeforeMouseDown = mocks.canvasFocus.mock.calls.length;
    container
      .querySelector('.canvas-area')
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(mocks.canvasFocus).toHaveBeenCalledTimes(focusCallsBeforeMouseDown + 1);
    expect(mocks.canvasFocus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(mocks.handleMouseDown).toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('paints chat highlights but only focuses a deliberately selected event', async () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 };
    mocks.buildSentenceDomRange.mockReturnValue({ getBoundingClientRect: () => rect });
    const { root } = await renderApp();

    await act(async () => state.childProps.controls.onToggleChat());
    expect(state.childProps.controls.showChat).toBe(true);
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

  it.each([null, { clientHeight: 500 }])(
    'tolerates a canvas wrapper without a focus method: %s',
    async (canvasWrapElement) => {
      state.canvasWrapElement = canvasWrapElement;
      const { container, root } = await renderApp();
      expect(() =>
        container
          .querySelector('.canvas-area')
          .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
      ).not.toThrow();
      expect(mocks.handleMouseDown).toHaveBeenCalledOnce();
      await act(async () => root.unmount());
    },
  );

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
