// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import ErrorBoundary from './ErrorBoundary.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    rerender(nextElement) {
      act(() => root.render(nextElement));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function Boom() {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders children when nothing throws', () => {
    const { container, unmount } = render(
      createElement(ErrorBoundary, null, createElement('div', null, 'hello')),
    );
    expect(container.textContent).toContain('hello');
    unmount();
  });

  it('renders a fallback with a reload affordance when a child throws', () => {
    const { container, unmount } = render(
      createElement(ErrorBoundary, { label: 'The canvas' }, createElement(Boom)),
    );
    expect(container.textContent).toContain('The canvas');
    expect(container.textContent).toContain('unexpected error');
    expect(container.querySelector('.pagetollm-error-details').textContent).toContain('kaboom');
    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Try again', 'Reload']);
    expect(consoleErrorSpy).toHaveBeenCalled();
    unmount();
  });

  it('reloads the page when the Reload button is clicked', () => {
    const { container, unmount } = render(createElement(ErrorBoundary, null, createElement(Boom)));
    const reloadSpy = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Reload')
        .click();
    });
    expect(reloadSpy).toHaveBeenCalled();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
    unmount();
  });

  it('renders a Close button and skips Reload when onDismiss is provided', () => {
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      createElement(ErrorBoundary, { label: 'The article rail', onDismiss }, createElement(Boom)),
    );
    const buttons = container.querySelectorAll('button');
    expect(Array.from(buttons).map((button) => button.textContent)).toEqual(['Try again', 'Close']);
    expect(container.textContent).not.toContain('Reload');
    unmount();
  });

  it('invokes onDismiss when the Close button is clicked', () => {
    const onDismiss = vi.fn();
    const { container, unmount } = render(
      createElement(ErrorBoundary, { onDismiss }, createElement(Boom)),
    );
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Close')
        .click();
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('remounts children when the built-in Try again action is used', () => {
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error('temporary failure');
      return createElement('div', null, 'recovered');
    }

    const { container, unmount } = render(
      createElement(ErrorBoundary, null, createElement(MaybeBoom)),
    );
    shouldThrow = false;
    act(() => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Try again')
        .click();
    });
    expect(container.textContent).toContain('recovered');
    unmount();
  });

  it('clears its fallback before invoking a caller-provided retry', () => {
    const onRetry = vi.fn();
    let shouldThrow = true;
    function MaybeBoom() {
      if (shouldThrow) throw new Error('temporary failure');
      return createElement('div', null, 'recovered');
    }
    const { container, unmount } = render(
      createElement(
        ErrorBoundary,
        { onRetry, onDismiss: vi.fn(), resetKeys: ['v1'] },
        createElement(MaybeBoom),
      ),
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.map((button) => button.textContent)).toEqual(['Try again', 'Close']);
    shouldThrow = false;
    act(() => buttons[0].click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('recovered');

    unmount();
  });

  it('recovers only after a reset key changes', () => {
    function MaybeBoom({ shouldThrow }) {
      if (shouldThrow) throw new Error('temporary failure');
      return createElement('div', null, 'recovered');
    }

    const renderBoundary = (resetKey, shouldThrow) =>
      createElement(
        ErrorBoundary,
        { resetKeys: [resetKey] },
        createElement(MaybeBoom, { shouldThrow }),
      );
    const { container, rerender, unmount } = render(renderBoundary('v1', true));

    expect(container.textContent).toContain('unexpected error');
    rerender(renderBoundary('v1', false));
    expect(container.textContent).toContain('unexpected error');
    rerender(renderBoundary('v2', false));
    expect(container.textContent).toContain('recovered');

    unmount();
  });
});
