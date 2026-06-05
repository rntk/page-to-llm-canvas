// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import SpinnerOverlay from './SpinnerOverlay.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('SpinnerOverlay', () => {
  it('renders the processing spinner with the stage by default', () => {
    const { container, unmount } = render(createElement(SpinnerOverlay, { stage: 'Summarizing' }));
    expect(container.querySelector('.pagetollm-spinner')).not.toBeNull();
    expect(container.querySelector('.pagetollm-spinner-stage').textContent).toBe('Summarizing');
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    unmount();
  });

  it('renders the missing state', () => {
    const { container, unmount } = render(createElement(SpinnerOverlay, { isMissing: true }));
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      'Article Not Found',
    );
    expect(container.querySelector('.pagetollm-spinner-retry-btn')).toBeNull();
    unmount();
  });

  it('renders the deleted state', () => {
    const { container, unmount } = render(createElement(SpinnerOverlay, { isDeleted: true }));
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      'Article Deleted',
    );
    unmount();
  });

  it('renders the pipeline error state with message and retry button', () => {
    const { container, unmount } = render(
      createElement(SpinnerOverlay, { recordError: 'boom', onRetry: () => {} }),
    );
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      'Processing Failed',
    );
    expect(container.querySelector('.pagetollm-spinner-error-body').textContent).toBe('boom');
    expect(container.querySelector('.pagetollm-spinner-retry-btn')).not.toBeNull();
    unmount();
  });

  it('shows the pipeline error panel even when recordError is an empty string', () => {
    const { container, unmount } = render(createElement(SpinnerOverlay, { recordError: '' }));
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      'Processing Failed',
    );
    // No message body, and no retry button when onRetry is omitted.
    expect(container.querySelector('.pagetollm-spinner-error-body')).toBeNull();
    expect(container.querySelector('.pagetollm-spinner-retry-btn')).toBeNull();
    unmount();
  });

  it('renders the hook-level error state', () => {
    const { container, unmount } = render(createElement(SpinnerOverlay, { error: 'offline' }));
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe('Error');
    expect(container.querySelector('.pagetollm-spinner-error-body').textContent).toBe('offline');
    unmount();
  });
});
