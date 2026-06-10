// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { closeModal } from './closeModal.js';

describe('closeModal', () => {
  let originalParent;
  let originalClose;

  beforeEach(() => {
    originalParent = window.parent;
    originalClose = window.close;
    window.close = vi.fn();
  });

  afterEach(() => {
    // Restore parent
    Object.defineProperty(window, 'parent', {
      value: originalParent,
      writable: true,
      configurable: true,
    });
    window.close = originalClose;
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
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'pagetollm-close' }, '*');
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
