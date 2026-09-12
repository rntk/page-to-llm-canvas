// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createModalHost, parseModalRoute } from './modalHost.js';

describe('modalHost', () => {
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

    createModalHost().onClose();

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

    createModalHost().onClose();

    expect(window.close).not.toHaveBeenCalled();
    expect(postMessageMock).toHaveBeenCalledWith(
      { type: 'pagetollm-close' },
      'https://host.example',
    );
    expect(postMessageMock).toHaveBeenCalledWith({ type: 'pagetollm-close' }, '*');
  });

  it('falls back to the referrer origin when ancestorOrigins is unavailable', () => {
    delete window.location.ancestorOrigins;
    Object.defineProperty(document, 'referrer', {
      value: 'https://referrer.example/article',
      configurable: true,
    });

    const postMessageMock = vi.fn();
    Object.defineProperty(window, 'parent', {
      value: { postMessage: postMessageMock },
      writable: true,
      configurable: true,
    });
    createModalHost().onNavigateToSentences({ key: 'k1', sentenceNumbers: [1] });
    expect(postMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'pagetollm-scroll-to-topic-sentences',
        key: 'k1',
        sentenceNumbers: [1],
      }),
      'https://referrer.example',
    );

    delete document.referrer;
  });

  it('safely catches and noops on any thrown exceptions', () => {
    Object.defineProperty(window, 'parent', {
      get() {
        throw new Error('Access denied');
      },
      configurable: true,
    });

    expect(() => createModalHost().onClose()).not.toThrow();
  });
});

describe('parseModalRoute', () => {
  it('extracts key and view from a query string', () => {
    expect(parseModalRoute('?key=abc&view=hierarchy')).toEqual({ key: 'abc', view: 'hierarchy' });
  });

  it('defaults missing values to empty strings', () => {
    expect(parseModalRoute('?key=abc')).toEqual({ key: 'abc', view: '' });
    expect(parseModalRoute('')).toEqual({ key: '', view: '' });
  });

  it('handles null and undefined', () => {
    expect(parseModalRoute(null)).toEqual({ key: '', view: '' });
    expect(parseModalRoute(undefined)).toEqual({ key: '', view: '' });
  });

  it('handles malformed but URLSearchParams-tolerant input', () => {
    expect(parseModalRoute('key=onlyNoQ')).toEqual({ key: 'onlyNoQ', view: '' });
    expect(parseModalRoute('?foo=bar&key=mykey&view=canvas')).toEqual({
      key: 'mykey',
      view: 'canvas',
    });
  });

  it('returns empty strings for keys with no value', () => {
    expect(parseModalRoute('?key&view')).toEqual({ key: '', view: '' });
  });

  it('returns empty strings when URLSearchParams throws', () => {
    const spy = vi.spyOn(globalThis, 'URLSearchParams').mockImplementation(() => {
      throw new Error('bad query');
    });
    expect(parseModalRoute('?key=abc')).toEqual({ key: '', view: '' });
    spy.mockRestore();
  });
});
