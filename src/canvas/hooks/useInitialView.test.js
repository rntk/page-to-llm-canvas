// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { useInitialView } from './useInitialView.js';
import { clampScale } from '../../utils/canvasMath.js';

// The hook returns void; its behaviour is observed through the callbacks and
// refs it drives across the three phases (level-set → zoomed → first topic).
function makeProps({ viewport: viewportOverrides, ...overrides } = {}) {
  return {
    topics: [{ title: 'T' }],
    sentenceMetrics: new Map([[1, { top: 0, bottom: 10 }]]),
    maxLevel: 0,
    selectedLevel: 0,
    setSelectedLevel: vi.fn(),
    // The transform hook hands consumers one imperative handle, so the live
    // transform refs and setTransformNow travel together here too.
    viewport: {
      userMovedCanvasRef: { current: false },
      setTransformNow: vi.fn(),
      scaleRef: { current: 1 },
      translateRef: { current: { x: 40, y: 40 } },
      ...viewportOverrides,
    },
    showSummaryMode: false,
    summaryCards: [],
    zoomAdjustedTopicCards: [{ fullPath: 'A', levelIndex: 0, startSentence: 1, key: 'kA' }],
    summaryMetricsState: new Map(),
    panToTopic: vi.fn(),
    selectTopic: vi.fn(),
    ...overrides,
  };
}

function setup(initialProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let props = initialProps;
  function Harness() {
    useInitialView(props);
    return null;
  }
  const root = createRoot(container);
  act(() => root.render(createElement(Harness)));
  return {
    props,
    rerender(overrides) {
      props = { ...props, ...overrides };
      act(() => root.render(createElement(Harness)));
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useInitialView', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((fn) => setTimeout(fn, 0));
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => clearTimeout(id));
  });
  afterEach(() => vi.restoreAllMocks());

  it('runs the full opening view when maxLevel is 0 (no level switch needed)', () => {
    const props = makeProps({ maxLevel: 0 });
    const ctx = setup(props);
    // Phase 1 needs no setSelectedLevel because there is no deeper level.
    expect(props.setSelectedLevel).not.toHaveBeenCalled();
    // Phase 2 zoomed out ~3 "-" clicks: scale / 1.2^3.
    expect(props.viewport.setTransformNow).toHaveBeenCalledTimes(1);
    expect(props.viewport.setTransformNow).toHaveBeenCalledWith(clampScale(1 / 1.2 ** 3), {
      x: 40,
      y: 40,
    });
    // Phase 3 selected the first topic.
    expect(props.selectTopic).toHaveBeenCalledWith({ path: 'A', cardKey: 'kA' });
    expect(props.panToTopic).toHaveBeenCalledTimes(1);
    ctx.cleanup();
  });

  it('jumps to the leaf level first, then waits for it to commit before zooming', () => {
    const props = makeProps({ maxLevel: 3, selectedLevel: 0 });
    const ctx = setup(props);
    // Phase 1 sets the leaf level but phase 2 is gated until selectedLevel lands.
    expect(props.setSelectedLevel).toHaveBeenCalledWith(3);
    expect(props.viewport.setTransformNow).not.toHaveBeenCalled();

    // Simulate the level switcher committing the leaf level.
    ctx.rerender({ selectedLevel: 3 });
    expect(props.viewport.setTransformNow).toHaveBeenCalledTimes(1);
    expect(props.panToTopic).toHaveBeenCalledTimes(1);
    ctx.cleanup();
  });

  it('skips the opening view when the user already moved the canvas', () => {
    const props = makeProps({ viewport: { userMovedCanvasRef: { current: true } } });
    const ctx = setup(props);
    expect(props.setSelectedLevel).not.toHaveBeenCalled();
    expect(props.viewport.setTransformNow).not.toHaveBeenCalled();
    expect(props.panToTopic).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('skips the opening view when a non-default level is already active', () => {
    const props = makeProps({ selectedLevel: 2, maxLevel: 3 });
    const ctx = setup(props);
    expect(props.setSelectedLevel).not.toHaveBeenCalled();
    expect(props.viewport.setTransformNow).not.toHaveBeenCalled();
    ctx.cleanup();
  });

  it('does nothing until the article and hierarchy are measured', () => {
    const empty = makeProps({ topics: [] });
    const ctx = setup(empty);
    expect(empty.viewport.setTransformNow).not.toHaveBeenCalled();

    const noMetrics = makeProps({ sentenceMetrics: new Map() });
    const ctx2 = setup(noMetrics);
    expect(noMetrics.viewport.setTransformNow).not.toHaveBeenCalled();

    ctx.cleanup();
    ctx2.cleanup();
  });

  it('still advances through the phases when no first topic can be found', () => {
    const props = makeProps({ zoomAdjustedTopicCards: [] });
    const ctx = setup(props);
    // Phase 2 still zoomed; phase 3 found no target so made no selection.
    expect(props.viewport.setTransformNow).toHaveBeenCalledTimes(1);
    expect(props.selectTopic).not.toHaveBeenCalled();
    expect(props.panToTopic).not.toHaveBeenCalled();
    ctx.cleanup();
  });
});
