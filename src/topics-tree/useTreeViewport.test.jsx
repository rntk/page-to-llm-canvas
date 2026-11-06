// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useTreeViewport } from './useTreeViewport.js';

let mounted = [];

function ViewportHarness() {
  const { canvasRef, stageRef, boundsRef } = useTreeViewport();
  useEffect(() => {
    boundsRef.current = { minY: 10, height: 1000 };
  }, [boundsRef]);
  return createElement(
    'div',
    { ref: canvasRef, className: 'canvas', style: { height: '500px' } },
    createElement(
      'div',
      { ref: stageRef, className: 'stage' },
      createElement('input', { 'aria-label': 'edit' }),
      createElement('div', { className: 'tt-card', tabIndex: 0 }, 'Card'),
    ),
  );
}

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(ViewportHarness)));
  const stage = container.querySelector('.stage');
  const unmount = () => {
    act(() => root.unmount());
    container.remove();
    mounted = mounted.filter((cleanup) => cleanup !== unmount);
  };
  mounted.push(unmount);
  return { container, stage, unmount };
}

afterEach(() => mounted.slice().forEach((cleanup) => cleanup()));

function press(key, target = window) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  act(() => target.dispatchEvent(event));
  return event;
}

describe('useTreeViewport keyboard navigation', () => {
  it('pans by arrows and pages, and sends Home/End to the tree bounds', () => {
    const { container, stage } = render();
    const canvas = container.querySelector('.canvas');
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 500 });
    expect(stage.style.transform).toBe('translate(24px, 24px) scale(1)');

    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown']) {
      expect(press(key).defaultPrevented).toBe(true);
    }
    // Opposing key presses cancel; Page movement uses 80% of viewport height.
    expect(stage.style.transform).toBe('translate(24px, 24px) scale(1)');
    press('PageDown');
    expect(stage.style.transform).toBe('translate(24px, -376px) scale(1)');
    press('Home');
    expect(stage.style.transform).toBe('translate(24px, 14px) scale(1)');
    press('End');
    expect(stage.style.transform).toBe('translate(24px, -534px) scale(1)');
  });

  it('leaves editable targets and cards alone, and removes its window listener on unmount', () => {
    const { container, stage, unmount } = render();
    const input = container.querySelector('input');
    const card = container.querySelector('.tt-card');
    for (const target of [input, card]) {
      for (const key of ['ArrowDown', 'PageDown', 'Home', 'End']) {
        expect(press(key, target).defaultPrevented).toBe(false);
      }
    }
    expect(stage.style.transform).toBe('translate(24px, 24px) scale(1)');

    unmount();
    expect(press('ArrowDown').defaultPrevented).toBe(false);
  });
});
