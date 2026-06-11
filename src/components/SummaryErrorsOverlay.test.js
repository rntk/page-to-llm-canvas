// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import SummaryErrorsOverlay from './SummaryErrorsOverlay.jsx';

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

const ERRORS = [
  { topic: 'Tech>AI', error_kind: 'timeout', error_message: 'The model did not respond in time.' },
  { topic: 'Tech>Hardware', error_kind: 'rate_limited', error_message: 'Rate limited.' },
];

describe('SummaryErrorsOverlay', () => {
  it('renders the failed topics and their reasons', () => {
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: ERRORS,
        onRetry: () => {},
        onSkip: () => {},
      }),
    );
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      '2 topics could not be summarized',
    );
    const items = container.querySelectorAll('.pagetollm-summary-errors-item');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('Tech>AI');
    expect(items[0].textContent).toContain('did not respond');
    unmount();
  });

  it('uses singular wording for a single failure', () => {
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: [ERRORS[0]],
        onRetry: () => {},
        onSkip: () => {},
      }),
    );
    expect(container.querySelector('.pagetollm-spinner-error-title').textContent).toBe(
      '1 topic could not be summarized',
    );
    unmount();
  });

  it('invokes onRetry / onSkip and disables buttons while the decision is in flight', async () => {
    let resolveRetry;
    const onRetry = vi.fn(() => new Promise((r) => (resolveRetry = r)));
    const onSkip = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, { summaryErrors: ERRORS, onRetry, onSkip }),
    );

    const retryBtn = container.querySelector('.pagetollm-spinner-retry-btn');
    const skipBtn = container.querySelector('.pagetollm-spinner-skip-btn');

    await act(async () => {
      retryBtn.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    // All actions disabled while the send is pending.
    expect(retryBtn.disabled).toBe(true);
    expect(skipBtn.disabled).toBe(true);

    // A second click is ignored while busy.
    await act(async () => {
      skipBtn.click();
    });
    expect(onSkip).not.toHaveBeenCalled();

    await act(async () => {
      resolveRetry();
    });
    unmount();
  });

  it('re-enables buttons when the decision send rejects', async () => {
    const onRetry = vi.fn(() => Promise.reject(new Error('send failed')));
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: ERRORS,
        onRetry,
        onSkip: () => {},
      }),
    );
    const retryBtn = container.querySelector('.pagetollm-spinner-retry-btn');
    await act(async () => {
      retryBtn.click();
    });
    expect(retryBtn.disabled).toBe(false);
    unmount();
  });
});
