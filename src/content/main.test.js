// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { act } from 'react';

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

  it('resets block numbers and counter properly on removal', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = document.getElementById('rsstag-pick-btn');
    expect(pickBtn).not.toBeNull();

    // Enable picking and select dummy 1
    await act(async () => {
      pickBtn.click();
    });

    const dummy1 = document.createElement('div');
    dummy1.id = 'dummy-1';
    document.body.appendChild(dummy1);
    await act(async () => {
      dummy1.click();
    });

    let listItems = document.querySelectorAll('.rsstag-block-item');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('Block 1');

    // Remove the block
    const removeBtn = listItems[0].querySelector('.rsstag-remove-btn');
    await act(async () => {
      removeBtn.click();
    });

    listItems = document.querySelectorAll('.rsstag-block-item');
    expect(listItems).toHaveLength(0);

    // Enable picking again and select dummy 2
    await act(async () => {
      pickBtn.click();
    });

    const dummy2 = document.createElement('div');
    dummy2.id = 'dummy-2';
    document.body.appendChild(dummy2);
    await act(async () => {
      dummy2.click();
    });

    listItems = document.querySelectorAll('.rsstag-block-item');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('Block 1');

    // Clean up
    dummy1.remove();
    dummy2.remove();
    const cancelBtn = document.getElementById('rsstag-cancel-btn');
    if (cancelBtn) {
      await act(async () => {
        cancelBtn.click();
      });
    }
  });

  it('aborts openInPageRail if closeInPageRail is called before loading finishes', async () => {
    let resolveMessage = null;
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'getRecord' && msg.key === 'delay-key') {
        resolveMessage = () =>
          cb({
            ok: true,
            record: {
              key: 'delay-key',
              status: 'done',
              selectors: ['body'],
              topics: [],
            },
          });
      } else {
        cb({ ok: false });
      }
    });

    const sendResponse = vi.fn();
    messageListener(
      { action: 'openRecordView', key: 'delay-key', mode: 'topics' },
      {},
      sendResponse,
    );

    expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();

    messageListener({ action: 'openRecordView', key: 'canvas-key', mode: 'canvas' }, {}, vi.fn());

    expect(document.getElementById('pagetollm-canvas-iframe')).not.toBeNull();

    expect(resolveMessage).not.toBeNull();
    await act(async () => {
      resolveMessage();
    });

    expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();

    const iframe = document.getElementById('pagetollm-canvas-iframe');
    if (iframe) iframe.remove();
  });

  it('replaces an existing summaries rail when popup opens topics view', async () => {
    const host = document.createElement('main');
    host.id = 'rail-switch-host';
    host.textContent = 'Alpha sentence. Beta sentence.';
    document.body.appendChild(host);

    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'getRecord' && msg.key === 'switch-key') {
        cb({
          ok: true,
          record: {
            key: 'switch-key',
            status: 'done',
            selectors: ['#rail-switch-host'],
            sentences: ['Alpha sentence.', 'Beta sentence.'],
            topics: [{ name: 'Topic A', sentences: [0, 1] }],
            topic_summary_index: {
              'Topic A': {
                level: 0,
                text: 'Summary A',
                source_sentences: [0, 1],
              },
            },
          },
        });
        return;
      }
      cb({ ok: false });
    });

    await act(async () => {
      messageListener(
        { action: 'openRecordView', key: 'switch-key', mode: 'summaries' },
        {},
        vi.fn(),
      );
      await Promise.resolve();
    });

    let rails = document.querySelectorAll('#pagetollm-in-page-rail');
    expect(rails).toHaveLength(1);
    expect(rails[0].dataset.mode).toBe('summaries');

    await act(async () => {
      messageListener({ action: 'openRecordView', key: 'switch-key', mode: 'topics' }, {}, vi.fn());
      await Promise.resolve();
    });

    rails = document.querySelectorAll('#pagetollm-in-page-rail');
    expect(rails).toHaveLength(1);
    expect(rails[0].dataset.mode).toBe('topics');
    expect(document.querySelector('.pagetollm-summary-active-card')).toBeNull();

    messageListener(
      { action: 'openRecordView', key: 'cleanup-canvas', mode: 'canvas' },
      {},
      vi.fn(),
    );
    document.getElementById('pagetollm-canvas-iframe')?.remove();
    host.remove();
  });
});
