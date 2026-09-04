// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { act } from 'react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let messageListener = null;
let postMessageListener = null;
let storageChangeListener = null;
let loadContentModule = null;

function toolbarRoot() {
  return window.__pagetollmTestSelectionToolbarRoot;
}

function toolbarQuery(selector) {
  return toolbarRoot()?.querySelector(selector) ?? null;
}

function toolbarQueryAll(selector) {
  return toolbarRoot()?.querySelectorAll(selector) ?? [];
}

beforeAll(async () => {
  const [selection, inPageRail, youTubeRail, recordFrame] = await Promise.all([
    import('./lazy/selectionSurface.js'),
    import('./lazy/inPageRailSurface.js'),
    import('./lazy/youTubeRailSurface.js'),
    import('./lazy/recordFrameSurface.js'),
  ]);
  const lazyModules = {
    'content-selection.js': selection,
    'content-in-page-rail.js': inPageRail,
    'content-youtube-rail.js': youTubeRail,
    'content-record-frame.js': recordFrame,
  };
  loadContentModule = vi.fn((path) => {
    const module = lazyModules[path];
    if (module) return module;
    throw new Error(`Unexpected content module: ${path}`);
  });
  vi.stubGlobal('__pagetollmLoadContentModule', loadContentModule);
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: vi.fn((fn) => {
          messageListener = fn;
        }),
      },
      sendMessage: vi.fn(),
      getURL: vi.fn((p) => 'about:blank#' + p),
    },
    storage: {
      local: {
        get: vi.fn((_key, cb) => cb({})),
      },
      onChanged: {
        addListener: vi.fn((fn) => {
          storageChangeListener = fn;
        }),
        removeListener: vi.fn((fn) => {
          if (storageChangeListener === fn) storageChangeListener = null;
        }),
      },
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

  afterEach(() => {
    document.getElementById('pagetollm-canvas-iframe')?.remove();
    document.getElementById('pagetollm-in-page-rail')?.remove();
    chrome.runtime.sendMessage.mockReset();
  });

  it('registers chrome runtime onMessage listener and window message listener', () => {
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(messageListener).not.toBeNull();
    expect(postMessageListener).not.toBeNull();
    expect(chrome.storage.onChanged.addListener).not.toHaveBeenCalled();
    expect(loadContentModule).not.toHaveBeenCalled();
  });

  it('listens for preference storage changes only while content UI is mounted', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
      await Promise.resolve();
    });

    const toolbar = document.getElementById('pagetollm-selection-toolbar');
    expect(toolbar).not.toBeNull();
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
    expect(storageChangeListener).not.toBeNull();

    storageChangeListener({ 'pagetollm:rec:test:meta': { newValue: { status: 'done' } } }, 'local');
    expect(toolbar.hasAttribute('data-theme')).toBe(false);

    storageChangeListener({ 'pagetollm-theme': { newValue: 'dark' } }, 'local');
    expect(toolbar.getAttribute('data-theme')).toBe('dark');

    storageChangeListener({ 'pagetollm-theme': { newValue: 'light' } }, 'local');
    expect(toolbar.getAttribute('data-theme')).toBe('light');

    const cancelBtn = toolbarQuery('#pagetollm-cancel-btn');
    await act(async () => {
      cancelBtn.click();
    });

    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(chrome.storage.onChanged.removeListener).toHaveBeenCalledTimes(1);
    expect(storageChangeListener).toBeNull();

    chrome.storage.local.get.mockImplementation((key, cb) => {
      if (key === 'pagetollm-theme') cb({ 'pagetollm-theme': 'dark' });
      else cb({});
    });

    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, vi.fn());
      await Promise.resolve();
    });

    const remountedToolbar = document.getElementById('pagetollm-selection-toolbar');
    expect(remountedToolbar.getAttribute('data-theme')).toBe('dark');
    expect(chrome.storage.onChanged.addListener).toHaveBeenCalledTimes(2);

    await act(async () => {
      toolbarQuery('#pagetollm-cancel-btn').click();
    });
    chrome.storage.local.get.mockImplementation((_key, cb) => cb({}));
  });

  it('handles startSelection message', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });
    expect(sendResponse).toHaveBeenCalledWith({ status: 'ready' });

    const toolbar = document.getElementById('pagetollm-selection-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar.shadowRoot).toBeNull();
    expect(toolbarQuery('#pagetollm-pick-btn')).not.toBeNull();
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

  it('handles openRecordView hierarchy mode', async () => {
    const sendResponse = vi.fn();
    const result = messageListener(
      { action: 'openRecordView', key: 'hierarchy key', mode: 'hierarchy' },
      {},
      sendResponse,
    );
    expect(result).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledWith({ status: 'ok' });
    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain('hierarchy%20key');
    expect(iframe.src).toContain('view=hierarchy');
  });

  it('keeps selection, rail, and record-frame surfaces mutually exclusive', async () => {
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, vi.fn());
    });
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBeNull();

    messageListener({ action: 'openRecordView', key: 'exclusive', mode: 'canvas' }, {}, vi.fn());
    await Promise.resolve();
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(document.getElementById('pagetollm-canvas-iframe')).not.toBeNull();

    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, vi.fn());
    });
    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
    expect(document.getElementById('pagetollm-selection-toolbar')).not.toBeNull();

    await act(async () => toolbarQuery('#pagetollm-cancel-btn').click());
  });

  it('handles postMessage close events', async () => {
    messageListener({ action: 'openRecordView', key: 'test-key', mode: 'canvas' }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = document.getElementById('pagetollm-canvas-iframe');
    expect(iframe).not.toBeNull();

    postMessageListener({
      data: { type: 'pagetollm-close' },
      source: iframe.contentWindow,
      origin: new URL(chrome.runtime.getURL('')).origin,
    });

    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
  });

  it('ignores forged iframe commands from the host page', async () => {
    messageListener({ action: 'openRecordView', key: 'test-key', mode: 'canvas' }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = document.getElementById('pagetollm-canvas-iframe');
    postMessageListener({
      data: { type: 'pagetollm-close' },
      source: window,
      origin: new URL(chrome.runtime.getURL('')).origin,
    });

    expect(document.getElementById('pagetollm-canvas-iframe')).toBe(iframe);
  });

  it('ignores forged iframe commands from a non-extension origin', async () => {
    messageListener({ action: 'openRecordView', key: 'test-key', mode: 'hierarchy' }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));

    const iframe = document.getElementById('pagetollm-canvas-iframe');
    postMessageListener({
      data: {
        type: 'pagetollm-scroll-to-topic-sentences',
        key: 'forged-key',
        sentenceNumbers: [0],
        level: 0,
        topicPath: 'Forged',
      },
      source: iframe.contentWindow,
      origin: 'https://attacker.example',
    });

    expect(document.getElementById('pagetollm-canvas-iframe')).toBe(iframe);
    expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();
  });

  it('routes a trusted topic-sentence command into the in-page rail', async () => {
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const railErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('requestAnimationFrame', (callback) => {
      callback(0);
      return 1;
    });
    const article = document.createElement('div');
    article.id = 'trusted-article';
    article.textContent = 'Alpha sentence. Beta sentence.';
    document.body.appendChild(article);
    chrome.runtime.sendMessage.mockImplementationOnce((_message, callback) =>
      callback({
        ok: true,
        record: {
          key: 'trusted-key',
          status: 'done',
          selectors: ['#trusted-article'],
          sentences: ['Alpha sentence.', 'Beta sentence.'],
          topics: [{ name: 'Parent > Child', sentences: [1, 2] }],
          topic_summary_index: {
            'Parent > Child': {
              level: 1,
              runs: [{ sentences: [1, 2], text: 'Summary text' }],
              source_sentences: [1, 2],
            },
          },
        },
      }),
    );

    messageListener({ action: 'openRecordView', key: 'trusted-key', mode: 'canvas' }, {}, vi.fn());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const iframe = document.getElementById('pagetollm-canvas-iframe');

    await act(async () => {
      postMessageListener({
        data: {
          type: 'pagetollm-scroll-to-topic-sentences',
          key: 'trusted-key',
          sentenceNumbers: [1],
          level: 1,
          topicPath: 'Parent > Child',
        },
        source: iframe.contentWindow,
        origin: new URL(chrome.runtime.getURL('')).origin,
      });
      await Promise.resolve();
    });

    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
    const rail = document.getElementById('pagetollm-in-page-rail');
    expect(rail).not.toBeNull();
    expect(rail.dataset.mode).toBe('topics');
    expect(rail.querySelector('[data-level="1"]').className).toContain('active');
    expect(railErrorSpy).not.toHaveBeenCalled();
    article.remove();
    railErrorSpy.mockRestore();
    vi.stubGlobal('requestAnimationFrame', originalRequestAnimationFrame);
  });

  it('resets block numbers and counter properly on removal', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
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

    let listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('Block 1');

    // Remove the block
    const removeBtn = listItems[0].querySelector('.pagetollm-remove-btn');
    await act(async () => {
      removeBtn.click();
    });

    listItems = toolbarQueryAll('.pagetollm-block-item');
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

    listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('Block 1');

    // Clean up
    dummy1.remove();
    dummy2.remove();
    const cancelBtn = toolbarQuery('#pagetollm-cancel-btn');
    if (cancelBtn) {
      await act(async () => {
        cancelBtn.click();
      });
    }
  });

  it('steps a picked block up to its parent', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
    expect(pickBtn).not.toBeNull();

    const parent = document.createElement('article');
    parent.id = 'step-parent';
    const child = document.createElement('p');
    child.id = 'step-child';
    child.textContent = 'Child text.';
    parent.appendChild(child);
    document.body.appendChild(parent);

    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      child.click();
    });

    const listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(1);
    const stepUpBtn = listItems[0].querySelector('.pagetollm-stepup-btn');
    expect(stepUpBtn.disabled).toBe(false);

    await act(async () => {
      stepUpBtn.click();
    });
    expect(child.classList.contains('pagetollm-selected')).toBe(false);
    expect(parent.classList.contains('pagetollm-selected')).toBe(true);

    const cancelBtn = toolbarQuery('#pagetollm-cancel-btn');
    await act(async () => {
      cancelBtn.click();
    });
    parent.remove();
  });

  it('supports drag reordering of picked blocks', async () => {
    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
    expect(pickBtn).not.toBeNull();

    const parent = document.createElement('article');
    parent.id = 'step-parent';
    const child = document.createElement('p');
    child.id = 'step-child';
    child.textContent = 'Child text.';
    parent.appendChild(child);
    document.body.appendChild(parent);

    const sibling = document.createElement('section');
    sibling.id = 'drag-sibling';
    sibling.textContent = 'Sibling text.';
    document.body.appendChild(sibling);

    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      child.click();
    });
    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      sibling.click();
    });

    let listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(2);

    await act(async () => {
      listItems[0].dispatchEvent(new CustomEvent('dragstart', { bubbles: true }));
    });
    expect(toolbarQueryAll('.pagetollm-block-item')[0].className).toContain('pagetollm-dragging');

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('dragover', { bubbles: true, cancelable: true }),
      );
    });
    expect(toolbarQueryAll('.pagetollm-block-item')[1].className).toContain('pagetollm-drag-over');

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('drop', { bubbles: true, cancelable: true }),
      );
    });

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('dragend', { bubbles: true }),
      );
    });
    expect(toolbarQueryAll('.pagetollm-block-item')).toHaveLength(2);

    const cancelBtn = toolbarQuery('#pagetollm-cancel-btn');
    await act(async () => {
      cancelBtn.click();
    });
    parent.remove();
    sibling.remove();
  });

  it('submits the picked blocks after step-up and drag reordering', async () => {
    chrome.runtime.sendMessage.mockImplementationOnce((_message, callback) =>
      callback({ ok: true, key: 'step-submit-key' }),
    );

    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
    expect(pickBtn).not.toBeNull();

    const parent = document.createElement('article');
    parent.id = 'step-parent';
    const child = document.createElement('p');
    child.id = 'step-child';
    child.textContent = 'Child text.';
    parent.appendChild(child);
    document.body.appendChild(parent);

    const sibling = document.createElement('section');
    sibling.id = 'drag-sibling';
    sibling.textContent = 'Sibling text.';
    document.body.appendChild(sibling);

    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      child.click();
    });

    let listItems = toolbarQueryAll('.pagetollm-block-item');
    const stepUpBtn = listItems[0].querySelector('.pagetollm-stepup-btn');

    await act(async () => {
      stepUpBtn.click();
    });

    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      sibling.click();
    });

    listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(2);

    await act(async () => {
      listItems[0].dispatchEvent(new CustomEvent('dragstart', { bubbles: true }));
    });

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('dragover', { bubbles: true, cancelable: true }),
      );
    });

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('drop', { bubbles: true, cancelable: true }),
      );
    });

    await act(async () => {
      toolbarQueryAll('.pagetollm-block-item')[1].dispatchEvent(
        new CustomEvent('dragend', { bubbles: true }),
      );
    });

    const submitBtn = toolbarQuery('#pagetollm-submit-btn');
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submit',
        selectors: ['section#drag-sibling', 'article#step-parent'],
      }),
      expect.any(Function),
    );
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    parent.remove();
    sibling.remove();
  });

  it('submits only the parent selector when stepping a child up into an already picked parent', async () => {
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === 'submit') callback({ ok: true, key: 'dedup-submit-key' });
      else if (typeof callback === 'function') callback({ ok: false });
    });

    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
    expect(pickBtn).not.toBeNull();

    const parent = document.createElement('article');
    parent.id = 'dedup-parent';
    parent.textContent = 'Parent text. ';
    const child = document.createElement('p');
    child.id = 'dedup-child';
    child.textContent = 'Child text.';
    parent.appendChild(child);
    document.body.appendChild(parent);

    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      parent.click();
    });
    await act(async () => {
      pickBtn.click();
    });
    await act(async () => {
      child.click();
    });

    let listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(2);

    const stepUpBtn = listItems[1].querySelector('.pagetollm-stepup-btn');
    await act(async () => {
      stepUpBtn.click();
    });

    listItems = toolbarQueryAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(1);
    expect(listItems[0].textContent).toContain('Block 1');

    const submitBtn = toolbarQuery('#pagetollm-submit-btn');
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submit',
        selectors: ['article#dedup-parent'],
      }),
      expect.any(Function),
    );
    expect(chrome.runtime.sendMessage.mock.calls.at(-1)[0].selectors).toHaveLength(1);
    expect(child.classList.contains('pagetollm-selected')).toBe(false);
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    parent.remove();
  });

  it('submits selected blocks without immediately opening the canvas', async () => {
    chrome.runtime.sendMessage.mockImplementation((message, callback) => {
      if (message?.type === 'submit') callback({ ok: true, key: 'submitted-key' });
      else if (typeof callback === 'function') callback({ ok: false });
    });

    const sendResponse = vi.fn();
    await act(async () => {
      messageListener({ action: 'startSelection' }, {}, sendResponse);
    });

    const pickBtn = toolbarQuery('#pagetollm-pick-btn');
    await act(async () => {
      pickBtn.click();
    });

    const block = document.createElement('section');
    block.id = 'submit-block';
    block.textContent = 'Submitted block text.';
    document.body.appendChild(block);

    await act(async () => {
      block.click();
    });

    const submitBtn = toolbarQuery('#pagetollm-submit-btn');
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Allow the surface's async module load to settle before asserting.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'submit',
        html: expect.stringContaining('Submitted block text.'),
        selectors: ['section#submit-block'],
      }),
      expect.any(Function),
    );
    expect(document.getElementById('pagetollm-canvas-iframe')).toBeNull();
    expect(document.getElementById('pagetollm-selection-toolbar')).toBeNull();
    expect(block.classList.contains('pagetollm-selected')).toBe(false);

    block.remove();
  });

  it('aborts a pending in-page rail when another surface opens', async () => {
    let resolveMessage = null;
    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'getRecordView' && msg.key === 'delay-key') {
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

    // The surface loads asynchronously; poll briefly until getRecord is observed
    // instead of relying on a single 0ms tick.
    for (let i = 0; i < 10 && !resolveMessage; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    }

    expect(document.getElementById('pagetollm-in-page-rail')).toBeNull();

    messageListener({ action: 'openRecordView', key: 'canvas-key', mode: 'canvas' }, {}, vi.fn());

    await new Promise((resolve) => setTimeout(resolve, 0));

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
      if (msg.type === 'getRecordView' && msg.key === 'switch-key') {
        cb({
          ok: true,
          record: {
            key: 'switch-key',
            status: 'done',
            selectors: ['#rail-switch-host'],
            sentences: ['Alpha sentence.', 'Beta sentence.'],
            topics: [{ name: 'Topic A', sentences: [1, 2] }],
            topic_summary_index: {
              'Topic A': {
                level: 0,
                runs: [{ sentences: [1, 2], text: 'Summary A' }],
                source_sentences: [1, 2],
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

  it('opens the requested mode in a YouTube rail', async () => {
    const video = document.createElement('video');
    video.className = 'html5-main-video';
    let videoTime = 0;
    Object.defineProperty(video, 'currentTime', {
      get: () => videoTime,
      set: (next) => {
        videoTime = next;
      },
      configurable: true,
    });
    video.play = vi.fn(() => Promise.resolve());
    document.body.appendChild(video);

    chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'getRecordView' && msg.key === 'youtube-key') {
        cb({
          ok: true,
          record: {
            key: 'youtube-key',
            status: 'done',
            sourceUrl: 'https://www.youtube.com/watch?v=abc123',
            sentences: ['0:00 0 seconds Intro starts.', '0:30 30 seconds Middle starts.'],
            topics: [
              { name: 'Intro', sentences: [1] },
              { name: 'Middle', sentences: [2] },
            ],
            topic_summary_index: {
              Intro: {
                level: 0,
                runs: [{ sentences: [1], text: 'Intro summary' }],
                source_sentences: [1],
              },
              Middle: {
                level: 0,
                runs: [],
                source_sentences: [2],
              },
            },
          },
        });
        return;
      }
      cb({ ok: false });
    });

    const sendResponse = vi.fn();
    await act(async () => {
      messageListener(
        { action: 'openRecordView', key: 'youtube-key', mode: 'summaries', rail: 'youtube' },
        {},
        sendResponse,
      );
      await Promise.resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendResponse).toHaveBeenCalledWith({ status: 'ok' });
    const rail = document.getElementById('pagetollm-in-page-rail');
    expect(rail).not.toBeNull();
    expect(rail.dataset.youtube).toBe('true');
    expect(rail.dataset.mode).toBe('summaries');

    let cards = rail.querySelectorAll('.pagetollm-yt-rail-card');
    expect(cards).toHaveLength(1);
    expect(rail.textContent).toContain('Intro summary');
    // Topics without a generated summary are omitted from summaries mode.
    expect(rail.textContent).not.toContain('Middle');
    const modeSelect = rail.querySelector('.pagetollm-rail-mode-select');
    await act(async () => {
      modeSelect.value = 'topics';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(rail.dataset.mode).toBe('topics');
    cards = rail.querySelectorAll('.pagetollm-yt-rail-card');
    expect(cards).toHaveLength(2);
    expect(rail.textContent).toContain('Middle');
    expect(rail.textContent).not.toContain('Intro summary');

    messageListener(
      { action: 'openRecordView', key: 'cleanup-canvas', mode: 'canvas' },
      {},
      vi.fn(),
    );
    document.getElementById('pagetollm-canvas-iframe')?.remove();
    video.remove();
  });
});
