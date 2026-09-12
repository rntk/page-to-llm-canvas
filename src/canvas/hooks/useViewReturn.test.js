// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useViewReturn } from './useViewReturn.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cleanups = [];

function setup(overrides = {}) {
  const props = {
    showSummaryMode: false,
    setShowSummaryMode: vi.fn(),
    skipNextAlignment: vi.fn(),
    flashFocus: vi.fn(),
    viewport: {
      scaleRef: { current: 0.4 },
      translateRef: { current: { x: 10, y: -200 } },
      userMovedCanvasRef: { current: false },
      setTransformNow: vi.fn(),
      flashZoomingToTarget: vi.fn(),
    },
    ...overrides,
  };

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const result = { current: null };
  let currentProps = props;

  function Harness() {
    result.current = useViewReturn(currentProps);
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

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe('useViewReturn', () => {
  it('offers no way back until a view is captured', () => {
    const ctx = setup();
    expect(ctx.result.current.hasReturnPoint).toBe(false);

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.setTransformNow).not.toHaveBeenCalled();
  });

  it('restores the captured scale and translate within the same mode', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    expect(ctx.result.current.hasReturnPoint).toBe(true);

    // The jump moves the canvas.
    ctx.props.viewport.scaleRef.current = 1.4;
    ctx.props.viewport.translateRef.current = { x: -300, y: -900 };

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledWith(0.4, { x: 10, y: -200 });
    expect(ctx.props.flashFocus).toHaveBeenCalledOnce();
    expect(ctx.props.viewport.userMovedCanvasRef.current).toBe(true);
    expect(ctx.props.setShowSummaryMode).not.toHaveBeenCalled();
    // Same window zoomToTarget guards: rects animate while scaleRef already
    // holds the restored scale.
    expect(ctx.props.viewport.flashZoomingToTarget).toHaveBeenCalledOnce();
  });

  it('swaps, so the control bounces between the two views', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    const zoomedIn = { x: -300, y: -900 };
    ctx.props.viewport.scaleRef.current = 1.4;
    ctx.props.viewport.translateRef.current = zoomedIn;

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.setTransformNow).toHaveBeenLastCalledWith(0.4, { x: 10, y: -200 });

    // Back at the reading view; the jump target is now what we return to.
    ctx.props.viewport.scaleRef.current = 0.4;
    ctx.props.viewport.translateRef.current = { x: 10, y: -200 };
    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.setTransformNow).toHaveBeenLastCalledWith(1.4, zoomedIn);
  });

  it('defers the restore until a captured summary mode has been re-entered', () => {
    const ctx = setup({ showSummaryMode: true });
    act(() => ctx.result.current.captureReturnPoint());

    // "Show source sentences" left summary mode and zoomed the article.
    ctx.rerender({ showSummaryMode: false });
    ctx.props.viewport.scaleRef.current = 1.4;
    ctx.props.viewport.translateRef.current = { x: -300, y: -900 };

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.setShowSummaryMode).toHaveBeenCalledWith(true);
    expect(ctx.props.skipNextAlignment).toHaveBeenCalledOnce();
    // The transform means nothing until the summary cards are mounted again.
    expect(ctx.props.viewport.setTransformNow).not.toHaveBeenCalled();
    expect(ctx.props.viewport.flashZoomingToTarget).not.toHaveBeenCalled();

    ctx.rerender({ showSummaryMode: true });
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledWith(0.4, { x: 10, y: -200 });
    expect(ctx.props.viewport.flashZoomingToTarget).toHaveBeenCalledOnce();
  });

  it('keeps capture and return stable across mode changes', () => {
    const ctx = setup();
    const first = ctx.result.current;

    ctx.rerender({ showSummaryMode: true });
    // App threads captureReturnPoint into handleChatHighlight, whose identity
    // must survive the mode change the first streamed highlight causes.
    expect(ctx.result.current.captureReturnPoint).toBe(first.captureReturnPoint);
    expect(ctx.result.current.returnToCapturedView).toBe(first.returnToCapturedView);

    // The snapshot still records the committed mode, not the one at mount.
    act(() => ctx.result.current.captureReturnPoint());
    ctx.rerender({ showSummaryMode: false });
    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.setShowSummaryMode).toHaveBeenCalledWith(true);
  });

  it('returns on Backspace, but not while typing', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    ctx.props.viewport.scaleRef.current = 1.4;

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(ctx.props.viewport.setTransformNow).not.toHaveBeenCalled();
    textarea.remove();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    });
    expect(ctx.props.viewport.setTransformNow).toHaveBeenCalledWith(0.4, { x: 10, y: -200 });
  });
});
