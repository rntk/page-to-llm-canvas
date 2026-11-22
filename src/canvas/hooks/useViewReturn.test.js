// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useViewReturn } from './useViewReturn.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const cleanups = [];

function setup(overrides = {}) {
  const live = { scale: 0.4, translate: { x: 10, y: -200 } };
  const props = {
    showSummaryMode: false,
    setShowSummaryMode: vi.fn(),
    skipNextAlignment: vi.fn(),
    // Live transform behind the handle's read command; tests move it to simulate jumps.
    viewport: {
      readTransform: () => ({ scale: live.scale, translate: { ...live.translate } }),
      restoreView: vi.fn(),
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
    live,
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
    expect(ctx.props.viewport.restoreView).not.toHaveBeenCalled();
  });

  it('restores the captured scale and translate within the same mode', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    expect(ctx.result.current.hasReturnPoint).toBe(true);

    // The jump moves the canvas.
    ctx.live.scale = 1.4;
    ctx.live.translate = { x: -300, y: -900 };

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.restoreView).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 0.4, translate: { x: 10, y: -200 } }),
    );
    expect(ctx.props.viewport.restoreView).toHaveBeenCalledOnce();
    expect(ctx.props.setShowSummaryMode).not.toHaveBeenCalled();
  });

  it('swaps, so the control bounces between the two views', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    const zoomedIn = { x: -300, y: -900 };
    ctx.live.scale = 1.4;
    ctx.live.translate = zoomedIn;

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.restoreView).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: 0.4, translate: { x: 10, y: -200 } }),
    );

    // Back at the reading view; the jump target is now what we return to.
    ctx.live.scale = 0.4;
    ctx.live.translate = { x: 10, y: -200 };
    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.viewport.restoreView).toHaveBeenLastCalledWith(
      expect.objectContaining({ scale: 1.4, translate: zoomedIn }),
    );
  });

  it('defers the restore until a captured summary mode has been re-entered', () => {
    const ctx = setup({ showSummaryMode: true });
    act(() => ctx.result.current.captureReturnPoint());

    // "Show source sentences" left summary mode and zoomed the article.
    ctx.rerender({ showSummaryMode: false });
    ctx.live.scale = 1.4;
    ctx.live.translate = { x: -300, y: -900 };

    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.setShowSummaryMode).toHaveBeenCalledWith(true);
    expect(ctx.props.skipNextAlignment).toHaveBeenCalledOnce();
    // The transform means nothing until the summary cards are mounted again.
    expect(ctx.props.viewport.restoreView).not.toHaveBeenCalled();

    ctx.rerender({ showSummaryMode: true });
    expect(ctx.props.viewport.restoreView).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 0.4, translate: { x: 10, y: -200 } }),
    );
    expect(ctx.props.viewport.restoreView).toHaveBeenCalledOnce();
  });

  it('keeps capture and return stable across mode changes', () => {
    const ctx = setup();
    const first = ctx.result.current;

    ctx.rerender({ showSummaryMode: true });
    // handleChatHighlight's identity must survive the mode change the first streamed highlight causes.
    expect(ctx.result.current.captureReturnPoint).toBe(first.captureReturnPoint);
    expect(ctx.result.current.returnToCapturedView).toBe(first.returnToCapturedView);

    // The snapshot still records the committed mode, not the one at mount.
    act(() => ctx.result.current.captureReturnPoint());
    ctx.rerender({ showSummaryMode: false });
    act(() => ctx.result.current.returnToCapturedView());
    expect(ctx.props.setShowSummaryMode).toHaveBeenCalledWith(true);
  });

  it('does not return on modified or already handled Backspace', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    for (const options of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { handled: true },
    ]) {
      const event = new KeyboardEvent('keydown', {
        key: 'Backspace',
        cancelable: true,
        ...options,
      });
      if (options.handled) event.preventDefault();
      act(() => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(!!options.handled);
    }
    expect(ctx.props.viewport.restoreView).not.toHaveBeenCalled();
  });

  it('returns on Backspace, but not while typing', () => {
    const ctx = setup();
    act(() => ctx.result.current.captureReturnPoint());
    ctx.live.scale = 1.4;

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }));
    });
    expect(ctx.props.viewport.restoreView).not.toHaveBeenCalled();
    textarea.remove();

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    });
    expect(ctx.props.viewport.restoreView).toHaveBeenCalledWith(
      expect.objectContaining({ scale: 0.4, translate: { x: 10, y: -200 } }),
    );
  });
});
