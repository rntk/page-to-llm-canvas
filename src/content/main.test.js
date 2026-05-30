// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

let messageListener = null;
let postMessageListener = null;

beforeAll(() => {
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn) => {
          messageListener = fn;
        }),
      },
      sendMessage: vi.fn(),
      getURL: vi.fn((p) => 'http://mock/' + p),
    },
  });

  vi.stubGlobal('alert', vi.fn());

  const originalAddEventListener = window.addEventListener;
  vi.spyOn(window, 'addEventListener').mockImplementation((event, fn, ...args) => {
    if (event === 'message') {
      postMessageListener = fn;
    }
    return originalAddEventListener(event, fn, ...args);
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('content script main.jsx', () => {
  beforeAll(async () => {
    await import('./main.jsx');
  });

  it('registers chrome runtime onMessage listener and window message listener', () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(messageListener).not.toBeNull();
    expect(postMessageListener).not.toBeNull();
  });

  it('handles startSelection message', () => {
    const sendResponse = vi.fn();
    messageListener({ action: 'startSelection' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ status: 'ready' });

    const toolbar = document.getElementById('rsstag-selection-toolbar');
    expect(toolbar).not.toBeNull();
  });

  it('handles openRecordView with missing key', async () => {
    const sendResponse = vi.fn();
    messageListener({ action: 'openRecordView' }, {}, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ status: 'error', error: 'missing key' });
  });

  it('handles openRecordView canvas mode', async () => {
    const sendResponse = vi.fn();
    const result = messageListener(
      { action: 'openRecordView', key: 'test-key', mode: 'canvas' },
      {},
      sendResponse,
    );
    expect(result).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledWith({ status: 'ok' });
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain('test-key');
  });

  it('handles postMessage close events', () => {
    expect(document.getElementById('pagetollm-canvas-iframe')).not.toBeNull();

    postMessageListener({ data: { type: 'pagetollm-close' } });

    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
  });
});
