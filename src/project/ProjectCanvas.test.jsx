// @vitest-environment happy-dom
import React, { Profiler, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { ChatDrawer } from './ChatDrawer.jsx';
import { DEFAULT_VIEWPORT, wheelZoomFactor } from './canvasLayout.js';

let container;
let root;
let frames;
let nextFrame;

function flushFrames() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  frames = new Map();
  nextFrame = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const tabs = [
  { id: 1, title: 'One', url: 'https://one.test' },
  { id: 2, title: 'Two', url: 'https://two.test' },
];

const layer = () => container.querySelector('[data-testid="canvas-layer"]');
const surface = () => container.querySelector('[data-testid="canvas-surface"]');
const nodes = () => [...container.querySelectorAll('[data-canvas-node]')];
const button = (label) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );

function pointer(target, type, x, y) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  target.dispatchEvent(event);
}

describe('ProjectCanvas', () => {
  beforeEach(async () => {
    await act(async () => root.render(<ProjectCanvas tabs={tabs} tabsHost={{}} />));
  });

  it('lays cards out in a grid inside the transformed layer', () => {
    expect(layer().style.transform).toBe(
      `translate(${DEFAULT_VIEWPORT.x}px, ${DEFAULT_VIEWPORT.y}px) scale(1)`,
    );
    expect(nodes().map((n) => n.style.transform)).toEqual([
      'translate(0px, 0px)',
      'translate(352px, 0px)',
    ]);
  });

  it('zooms with the buttons within limits and resets the view', async () => {
    for (let i = 0; i < 20; i += 1) await act(async () => button('Zoom in').click());
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('300%');
    for (let i = 0; i < 30; i += 1) await act(async () => button('Zoom out').click());
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('10%');
    await act(async () => button('Reset view').click());
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('100%');
    expect(layer().style.transform).toContain('scale(1)');
  });

  it('zooms on plain and Ctrl+wheel and prevents browser scrolling', async () => {
    const plain = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => surface().dispatchEvent(plain));
    expect(plain.defaultPrevented).toBe(true);
    act(flushFrames);
    expect(
      Number.parseInt(container.querySelector('.canvas-zoom-level').textContent),
    ).toBeGreaterThan(100);

    const ctrl = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 });
    // happy-dom's WheelEvent drops modifier init fields.
    Object.defineProperty(ctrl, 'ctrlKey', { value: true });
    await act(async () => surface().dispatchEvent(ctrl));
    expect(ctrl.defaultPrevented).toBe(true);
    act(flushFrames);
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('100%');
  });

  it('pans on a horizontal wheel swipe without zooming', async () => {
    const swipe = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 60,
      deltaY: 3,
    });
    await act(async () => surface().dispatchEvent(swipe));
    expect(swipe.defaultPrevented).toBe(true);
    act(flushFrames);
    expect(layer().style.transform).toBe(
      `translate(${DEFAULT_VIEWPORT.x - 60}px, ${DEFAULT_VIEWPORT.y}px) scale(1)`,
    );
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('100%');
  });

  it('pans with arrow keys and viewport-relative page keys', async () => {
    Object.defineProperty(surface(), 'clientHeight', { configurable: true, value: 500 });
    const press = async (key) => {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(true);
    };
    await press('ArrowRight');
    await press('ArrowDown');
    expect(layer().style.transform).toBe('translate(-40px, -40px) scale(1)');
    await press('ArrowLeft');
    await press('ArrowUp');
    await press('PageDown');
    expect(layer().style.transform).toBe('translate(40px, -360px) scale(1)');
    await press('PageUp');
    expect(layer().style.transform).toBe('translate(40px, 40px) scale(1)');
    Object.defineProperty(surface(), 'clientHeight', { configurable: true, value: 100 });
    await press('PageDown');
    expect(layer().style.transform).toBe('translate(40px, -80px) scale(1)');
  });

  it('leaves modified and already handled navigation keys alone', async () => {
    const initial = layer().style.transform;
    for (const options of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { handled: true },
    ]) {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowLeft',
        cancelable: true,
        ...options,
      });
      if (options.handled) event.preventDefault();
      await act(async () => window.dispatchEvent(event));
      expect(event.defaultPrevented).toBe(!!options.handled);
      expect(layer().style.transform).toBe(initial);
    }
  });

  it('moves Home and End using card bounds even without styling classes', async () => {
    Object.defineProperty(surface(), 'clientHeight', { configurable: true, value: 200 });
    surface().getBoundingClientRect = () => ({ top: 20, left: 0, width: 0, height: 200 });
    nodes().forEach((node) => {
      node.removeAttribute('class');
      node.getBoundingClientRect = () => {
        const [, y, zoom] = layer().style.transform.match(
          /translate\([^,]+, ([^)]+)px\) scale\(([^)]+)\)/,
        );
        const [, cardY] = node.style.transform.match(/translate\([^,]+, ([^)]+)px\)/);
        return { bottom: 20 + Number(y) + (Number(cardY) + 220) * Number(zoom) };
      };
    });
    await act(async () => button('Zoom in').click());
    await act(async () => {
      pointer(container.querySelector('.tab-card-header'), 'pointerdown', 0, 0);
      pointer(window, 'pointermove', 0, 120);
      pointer(window, 'pointerup', 0, 120);
    });
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' })));
    expect(layer().style.transform).toBe('translate(48px, -224px) scale(1.2)');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' })));
    expect(layer().style.transform).toBe('translate(48px, 40px) scale(1.2)');
  });

  it('leaves keyboard navigation to editable controls', async () => {
    const input = document.createElement('input');
    container.appendChild(input);
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(layer().style.transform).toBe('translate(40px, 40px) scale(1)');
    input.remove();
  });

  it('pans when dragging the background', async () => {
    await act(async () => {
      pointer(surface(), 'pointerdown', 100, 100);
      pointer(window, 'pointermove', 150, 130);
      flushFrames();
    });
    expect(layer().style.transform).toBe(
      `translate(${DEFAULT_VIEWPORT.x + 50}px, ${DEFAULT_VIEWPORT.y + 30}px) scale(1)`,
    );
    await act(async () => {
      pointer(window, 'pointerup', 150, 130);
      pointer(window, 'pointermove', 400, 400);
    });
    expect(layer().style.transform).toContain(`${DEFAULT_VIEWPORT.x + 50}px`);
  });

  it('coalesces viewport moves and wheel zoom without React commits and cancels pending work', async () => {
    const onRender = vi.fn();
    const renderCanvas = () =>
      root.render(
        <Profiler id="canvas" onRender={onRender}>
          <ProjectCanvas tabs={tabs} tabsHost={{}} />
        </Profiler>,
      );
    await act(async () => renderCanvas());
    onRender.mockClear();
    const initial = layer().style.transform;
    await act(async () => {
      pointer(surface(), 'pointerdown', 100, 100);
      pointer(window, 'pointermove', 120, 110);
      pointer(window, 'pointermove', 150, 130);
    });
    expect(frames.size).toBe(1);
    expect(layer().style.transform).toBe(initial);
    expect(onRender).not.toHaveBeenCalled();
    act(flushFrames);
    expect(layer().style.transform).toBe('translate(90px, 70px) scale(1)');
    await act(async () => pointer(window, 'pointerup', 150, 130));

    const wheel = () =>
      surface().dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }),
      );
    await act(async () => {
      wheel();
      wheel();
    });
    expect(frames.size).toBe(1);
    expect(layer().style.transform).toBe('translate(90px, 70px) scale(1)');
    expect(onRender).not.toHaveBeenCalled();
    act(flushFrames);
    const twiceZoomed = Number.parseInt(container.querySelector('.canvas-zoom-level').textContent);
    expect(twiceZoomed).toBe(Math.round(100 * wheelZoomFactor(-100, 0, 0) ** 2));
    expect(onRender).not.toHaveBeenCalled();
    const zoomedTransform = layer().style.transform;
    await act(async () => renderCanvas());
    expect(layer().style.transform).toBe(zoomedTransform);
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe(`${twiceZoomed}%`);

    await act(async () => wheel());
    expect(frames.size).toBe(1);
    act(() => root.unmount());
    expect(frames.size).toBe(0);
  });

  it('does not pan when dragging card content without node styling classes', async () => {
    nodes().forEach((node) => node.removeAttribute('class'));
    const before = layer().style.transform;
    await act(async () => {
      pointer(container.querySelector('.tab-card'), 'pointerdown', 10, 10);
      pointer(window, 'pointermove', 30, 50);
      pointer(window, 'pointerup', 30, 50);
    });
    expect(layer().style.transform).toBe(before);
  });

  it('drags a card by its header without panning the canvas', async () => {
    const header = container.querySelector('.tab-card-header');
    await act(async () => {
      pointer(header, 'pointerdown', 10, 10);
      pointer(window, 'pointermove', 30, 50);
      pointer(window, 'pointerup', 30, 50);
    });
    expect(nodes()[0].style.transform).toBe('translate(20px, 40px)');
    expect(layer().style.transform).toContain(`${DEFAULT_VIEWPORT.x}px`);
    expect(nodes()[1].style.transform).toBe('translate(352px, 0px)');
  });
});

describe('ProjectCanvas page chat folds', () => {
  const renderPageChat = (tab, { onClose }) => (
    <ChatDrawer label={tab.title} ariaLabel={`Chat for ${tab.title}`}>
      <span data-tab={tab.id} />
      <div className="scroller">messages</div>
      <button type="button" onClick={onClose}>
        Close drawer
      </button>
    </ChatDrawer>
  );
  const drawers = () => [...container.querySelectorAll('.page-chat-drawer')];
  const folds = () => [...container.querySelectorAll('.page-chat-fold')];

  beforeEach(async () => {
    await act(async () =>
      root.render(<ProjectCanvas tabs={tabs} tabsHost={{}} renderPageChat={renderPageChat} />),
    );
  });

  it('folds and unfolds each page chat independently from its side tab', async () => {
    expect(folds().map((fold) => fold.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(drawers()).toEqual([]);

    await act(async () => button('Unfold chat for Two').click());
    expect(drawers().map((drawer) => drawer.querySelector('[data-tab]').dataset.tab)).toEqual([
      '2',
    ]);
    expect(folds()[1].getAttribute('aria-expanded')).toBe('true');
    // The drawer sits between its card and the fold tab, inside the card's node.
    expect([...nodes()[1].children].map((child) => child.className)).toEqual([
      'tab-card',
      'page-chat-drawer',
      'page-chat-fold',
    ]);

    await act(async () => button('Unfold chat for One').click());
    expect(drawers().map((drawer) => drawer.querySelector('[data-tab]').dataset.tab)).toEqual([
      '1',
      '2',
    ]);

    await act(async () => button('Fold chat for Two').click());
    expect(drawers().map((drawer) => drawer.querySelector('[data-tab]').dataset.tab)).toEqual([
      '1',
    ]);
    await act(async () => button('Close drawer').click());
    expect(drawers()).toEqual([]);
  });

  it('lets chat scroll and take arrow keys without drawer styling classes', async () => {
    await act(async () => button('Unfold chat for One').click());
    drawers()[0].removeAttribute('class');
    const scroller = container.querySelector('.scroller');
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => scroller.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(container.querySelector('.canvas-zoom-level').textContent).toBe('100%');

    const ctrl = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    // Happy DOM ignores modifier keys in the WheelEvent init dictionary.
    Object.defineProperty(ctrl, 'ctrlKey', { value: true });
    await act(async () => scroller.dispatchEvent(ctrl));
    expect(ctrl.defaultPrevented).toBe(true);

    const before = layer().style.transform;
    const key = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    await act(async () => scroller.dispatchEvent(key));
    expect(key.defaultPrevented).toBe(false);
    expect(layer().style.transform).toBe(before);
  });
});
