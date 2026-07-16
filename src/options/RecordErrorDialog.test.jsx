// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import RecordErrorDialog from './RecordErrorDialog.jsx';

const cleanups = [];

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

function renderDialog(overrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = {
    sourceUrl: 'https://example.com/article',
    errorText: 'Request failed\nat worker.js:10\nat pipeline.js:20',
    onRetry: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };

  act(() => root.render(<RecordErrorDialog {...props} />));

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    act(() => root.unmount());
    container.remove();
  };
  cleanups.push(cleanup);
  return { container, props, cleanup };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('RecordErrorDialog', () => {
  it('renders an accessible dialog with source, message, and technical details', () => {
    const { container } = renderDialog();
    const dialog = container.querySelector('[role="alertdialog"]');

    expect(dialog).not.toBeNull();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(container.textContent).toContain('Processing Failed');
    expect(container.querySelector('.pagetollm-options-error-source').textContent).toBe(
      'https://example.com/article',
    );
    expect(container.querySelector('.pagetollm-spinner-error-msg').textContent).toBe(
      'Request failed',
    );
    expect(container.querySelector('details summary').textContent).toBe('Technical details');
    expect(container.querySelector('details pre').textContent).toBe(
      'at worker.js:10\nat pipeline.js:20',
    );
  });

  it('omits optional source and error body when no error message exists', () => {
    const { container } = renderDialog({ sourceUrl: '', errorText: null });

    expect(container.querySelector('.pagetollm-options-error-source')).toBeNull();
    expect(container.querySelector('.pagetollm-spinner-error-body')).toBeNull();
    expect(container.querySelector('.pagetollm-spinner-retry-btn').textContent).toBe('Retry');
  });

  it('closes from the backdrop or close button but not from the dialog box', () => {
    const onClose = vi.fn();
    const { container } = renderDialog({ onClose });
    const overlay = container.querySelector('.pagetollm-options-error-overlay');
    const box = container.querySelector('.pagetollm-spinner-box');

    act(() => box.click());
    expect(onClose).not.toHaveBeenCalled();

    act(() => container.querySelector('.pagetollm-spinner-close-btn').click());
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => overlay.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('disables both actions while retrying and remains busy after success', async () => {
    let resolveRetry;
    const onRetry = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const onClose = vi.fn();
    const { container } = renderDialog({ onRetry, onClose });
    const retryButton = container.querySelector('.pagetollm-spinner-retry-btn');
    const closeButton = container.querySelector('.pagetollm-spinner-close-btn');

    act(() => retryButton.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton.textContent).toBe('Retrying...');
    expect(retryButton.disabled).toBe(true);
    expect(closeButton.disabled).toBe(true);

    act(() => retryButton.click());
    act(() => closeButton.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => resolveRetry());
    expect(retryButton.textContent).toBe('Retrying...');
    expect(retryButton.disabled).toBe(true);
  });

  it('re-enables actions when retry rejects so the user can try again', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('send failed'));
    const { container } = renderDialog({ onRetry });
    const retryButton = container.querySelector('.pagetollm-spinner-retry-btn');
    const closeButton = container.querySelector('.pagetollm-spinner-close-btn');

    await act(async () => {
      retryButton.click();
      await Promise.resolve();
    });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(retryButton.textContent).toBe('Retry');
    expect(retryButton.disabled).toBe(false);
    expect(closeButton.disabled).toBe(false);
  });
});
