// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import SummaryErrorsOverlay from './SummaryErrorsOverlay.jsx';
import { StaleActionError } from '../shared/runtime/actionResponses.js';

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
    expect(container.textContent).toContain('Any new failures will still need review.');
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

  it('supports a host-specific close handler, class, and source label', () => {
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        className: 'host-overlay',
        sourceUrl: 'https://example.com/article',
        summaryErrors: ERRORS,
        onRetry: () => {},
        onSkip: () => {},
        onClose,
      }),
    );

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog.classList.contains('host-overlay')).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.querySelector('.pagetollm-summary-errors-source').textContent).toBe(
      'https://example.com/article',
    );

    act(() => container.querySelector('.pagetollm-spinner-close-btn').click());
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('focuses the primary action, traps Tab, closes with Escape, and restores focus', () => {
    const returnButton = document.createElement('button');
    document.body.appendChild(returnButton);
    returnButton.focus();
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: ERRORS,
        onRetry: () => {},
        onSkip: () => {},
        onClose,
      }),
    );
    const retryButton = container.querySelector('.pagetollm-spinner-retry-btn');
    const closeButton = container.querySelector('.pagetollm-spinner-close-btn');

    expect(document.activeElement).toBe(retryButton);

    closeButton.focus();
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })),
    );
    expect(document.activeElement).toBe(retryButton);

    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }),
      ),
    );
    expect(document.activeElement).toBe(closeButton);

    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);

    unmount();
    expect(document.activeElement).toBe(returnButton);
    returnButton.remove();
  });

  it('closes from the backdrop but not from the dialog box', () => {
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: ERRORS,
        onRetry: () => {},
        onSkip: () => {},
        onClose,
      }),
    );
    const overlay = container.querySelector('[role="alertdialog"]');
    const box = container.querySelector('.pagetollm-spinner-box');

    act(() => box.click());
    expect(onClose).not.toHaveBeenCalled();
    act(() => overlay.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('invokes onRetry / onSkip and disables buttons while the decision is in flight', async () => {
    let resolveRetry;
    const onRetry = vi.fn(() => new Promise((r) => (resolveRetry = r)));
    const onSkip = vi.fn();
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, { summaryErrors: ERRORS, onRetry, onSkip, onClose }),
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
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    act(() => container.querySelector('[role="alertdialog"]').click());
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveRetry();
    });
    unmount();
  });

  it('re-enables buttons and dismissal once a successful decision settles', async () => {
    let resolveRetry;
    const onRetry = vi.fn(() => new Promise((r) => (resolveRetry = r)));
    const onClose = vi.fn();
    const { container, unmount } = render(
      createElement(SummaryErrorsOverlay, {
        summaryErrors: ERRORS,
        onRetry,
        onSkip: () => {},
        onClose,
      }),
    );
    const retryBtn = container.querySelector('.pagetollm-spinner-retry-btn');
    const skipBtn = container.querySelector('.pagetollm-spinner-skip-btn');
    const closeBtn = container.querySelector('.pagetollm-spinner-close-btn');

    await act(async () => {
      retryBtn.click();
    });
    expect(closeBtn.disabled).toBe(true);

    await act(async () => {
      resolveRetry({ ok: true });
    });
    expect(retryBtn.disabled).toBe(false);
    expect(skipBtn.disabled).toBe(false);
    expect(closeBtn.disabled).toBe(false);

    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => container.querySelector('[role="alertdialog"]').click());
    expect(onClose).toHaveBeenCalledTimes(2);
    act(() => closeBtn.click());
    expect(onClose).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('reports a stale decision as information rather than a failure', async () => {
    const onRetry = vi.fn(() => Promise.reject(new StaleActionError()));
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

    const notice = container.querySelector('[role="status"]');
    expect(notice.textContent).toBe('This record has already been handled.');
    expect(container.querySelector('[role="alert"]')).toBe(null);
    expect(retryBtn.disabled).toBe(false);
    unmount();
  });

  it('clears the stale notice when a new attempt starts', async () => {
    let resolveRetry;
    const onRetry = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve({ ok: true, stale: true }))
      .mockImplementationOnce(() => new Promise((r) => (resolveRetry = r)));
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
    expect(container.textContent).toContain('This record has already been handled.');

    await act(async () => {
      retryBtn.click();
    });
    expect(container.textContent).not.toContain('This record has already been handled.');

    await act(async () => {
      resolveRetry({ ok: true });
    });
    unmount();
  });

  it('re-enables buttons and shows the failure when the decision send rejects', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    expect(container.textContent).toContain('send failed');
    expect(warnSpy).toHaveBeenCalledWith(
      'PageToLLM SummaryErrorsOverlay action failed:',
      'send failed',
    );
    unmount();
  });

  it('clears a previous action error when a new attempt starts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let resolveRetry;
    const onRetry = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new Error('send failed')))
      .mockImplementationOnce(() => new Promise((r) => (resolveRetry = r)));
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
    expect(container.textContent).toContain('send failed');

    await act(async () => {
      retryBtn.click();
    });
    expect(container.textContent).not.toContain('send failed');

    await act(async () => {
      resolveRetry();
    });
    unmount();
  });
});
