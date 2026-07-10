// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closeModal, getParentOrigin } from './closeModal.js';

describe('closeModal', () => {
  let originalParent;
  let originalClose;

  beforeEach(() => {
    originalParent = window.parent;
    originalClose = window.close;
    window.close = vi.fn();
    Object.defineProperty(window.location, 'ancestorOrigins', {
      value: ['https://host.example'],
      configurable: true,
    });
  });

  afterEach(() => {
    // Restore parent
    Object.defineProperty(window, 'parent', {
      value: originalParent,
      writable: true,
      configurable: true,
    });
    window.close = originalClose;
    delete window.location.ancestorOrigins;
  });

  it('calls window.close when window.parent === window', () => {
    Object.defineProperty(window, 'parent', {
      value: window,
      writable: true,
      configurable: true,
    });

    closeModal();

    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('sends postMessage to parent when window.parent !== window', () => {
    const postMessageMock = vi.fn();
    const mockParent = {
      postMessage: postMessageMock,
    };

    Object.defineProperty(window, 'parent', {
      value: mockParent,
      writable: true,
      configurable: true,
    });

    closeModal();

    expect(window.close).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      { type: 'pagetollm-close' },
      'https://host.example',
    );
  });

  it('falls back to the referrer origin when ancestorOrigins is unavailable', () => {
    delete window.location.ancestorOrigins;
    Object.defineProperty(document, 'referrer', {
      value: 'https://referrer.example/article',
      configurable: true,
    });

    expect(getParentOrigin()).toBe('https://referrer.example');

    delete document.referrer;
  });

  it('safely catches and noops on any thrown exceptions', () => {
    Object.defineProperty(window, 'parent', {
      get() {
        throw new Error('Access denied');
      },
      configurable: true,
    });

    expect(() => closeModal()).not.toThrow();
  });
});
