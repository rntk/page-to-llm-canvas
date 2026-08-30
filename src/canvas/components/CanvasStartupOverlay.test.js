// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import CanvasStartupOverlay from './CanvasStartupOverlay.jsx';

function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(CanvasStartupOverlay, props)));
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('CanvasStartupOverlay', () => {
  it('renders the step label and a bar sized to the progress', () => {
    const { container, cleanup } = render({ progress: 0.68, label: 'Measuring topic layout' });
    expect(container.querySelector('.canvas-startup__label').textContent).toBe(
      'Measuring topic layout',
    );
    const bar = container.querySelector('.canvas-startup__bar');
    expect(bar.style.width).toBe('68%');
    const track = container.querySelector('.canvas-startup__track');
    expect(track.getAttribute('aria-valuenow')).toBe('68');
    expect(container.querySelector('.canvas-startup').className).not.toContain('is-leaving');
    cleanup();
  });

  it('clamps out-of-range progress', () => {
    const low = render({ progress: -1, label: 'x' });
    expect(low.container.querySelector('.canvas-startup__bar').style.width).toBe('0%');
    low.cleanup();
    const high = render({ progress: 4, label: 'x' });
    expect(high.container.querySelector('.canvas-startup__bar').style.width).toBe('100%');
    high.cleanup();
  });

  it('swallows mouse presses so staging is not cancelled by a blind drag', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onMouseDown = vi.fn();
    const root = createRoot(container);
    act(() =>
      root.render(
        createElement(
          'div',
          { onMouseDown },
          createElement(CanvasStartupOverlay, { progress: 0.3, label: 'x' }),
        ),
      ),
    );
    act(() => {
      container
        .querySelector('.canvas-startup')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
    expect(onMouseDown).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('is hidden from assistive tech while fading out', () => {
    const { container, cleanup } = render({ progress: 1, label: 'Ready', isLeaving: true });
    const overlay = container.querySelector('.canvas-startup');
    expect(overlay.className).toContain('is-leaving');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    cleanup();
  });
});
