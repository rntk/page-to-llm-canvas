// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import {
  DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS,
  MAX_LLM_REQUEST_TIMEOUT_SECONDS,
  MIN_LLM_REQUEST_TIMEOUT_SECONDS,
} from '../../worker/settings/llmTimeout.js';

async function waitFor(assertion, timeout = 1000) {
  const start = Date.now();
  let lastError;

  while (Date.now() - start < timeout) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  throw lastError;
}

describe('options main.jsx', () => {
  let sendMessageMock;
  let confirmMock;
  let alertMock;

  beforeEach(() => {
    vi.resetModules();
    window.history.replaceState(null, '', window.location.pathname);

    const rootEl = document.createElement('div');
    rootEl.id = 'options-root';
    document.body.appendChild(rootEl);

    sendMessageMock = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: sendMessageMock,
      },
      // Keep storage itself present while leaving the optional APIs absent.
      // Dedicated metric tests cover a wholly missing storage namespace; doing
      // that in mounted React effects turns expected mutant failures into
      // unhandled rejections before Stryker can attribute them to an assertion.
      storage: {},
    });

    confirmMock = vi.fn(() => true);
    alertMock = vi.fn();
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('alert', alertMock);
  });

  afterEach(() => {
    const rootEl = document.getElementById('options-root');
    if (rootEl) rootEl.remove();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('organizes settings into accessible, hash-persisted tabs', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      if (msg.type === 'listProviders') cb({ ok: true, providers: [], activeId: null });
    });

    await import('./main.jsx');

    await waitFor(() => {
      expect(document.querySelectorAll('[role="tab"]')).toHaveLength(5);
    });

    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const generalPanel = document.getElementById('options-panel-general');
    const recordsPanel = document.getElementById('options-panel-records');

    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(generalPanel.hidden).toBe(false);
    expect(recordsPanel.hidden).toBe(true);
    const requestTimeoutInput = document.getElementById('llm-request-timeout-seconds');
    expect(requestTimeoutInput.value).toBe(String(DEFAULT_LLM_REQUEST_TIMEOUT_SECONDS));
    expect(requestTimeoutInput.min).toBe(String(MIN_LLM_REQUEST_TIMEOUT_SECONDS));
    expect(requestTimeoutInput.max).toBe(String(MAX_LLM_REQUEST_TIMEOUT_SECONDS));

    tabs[2].click();
    await waitFor(() => {
      expect(tabs[2].getAttribute('aria-selected')).toBe('true');
      expect(window.location.hash).toBe('#records');
      expect(generalPanel.hidden).toBe(true);
      expect(recordsPanel.hidden).toBe(false);
    });

    tabs[2].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await waitFor(() => {
      expect(tabs[4].getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(tabs[4]);
      expect(window.location.hash).toBe('#diagnostics');
    });
  });

  it('reveals the provider form only while adding a provider', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      if (msg.type === 'listProviders') cb({ ok: true, providers: [], activeId: null });
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('[role="tab"]')).not.toBeNull();
    });

    expect(document.querySelector('.provider-form')).toBeNull();
    const addButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add provider',
    );
    addButton.click();
    await waitFor(() => {
      expect(document.querySelector('.provider-form')).not.toBeNull();
    });

    const cancelButton = Array.from(document.querySelectorAll('.provider-form button')).find(
      (button) => button.textContent === 'Cancel',
    );
    cancelButton.click();
    await waitFor(() => {
      expect(document.querySelector('.provider-form')).toBeNull();
    });
  });

  it('renders loading state then list of records', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'rec1',
              sourceUrl: 'https://example.com',
              snippet: 'A short preview of the selected document.',
              createdAt: 1716972000000,
              status: 'done',
            },
          ],
        });
      }
    });

    await import('./main.jsx');

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'listRecords' }, expect.any(Function));
      expect(document.querySelector('table')).not.toBeNull();
    });

    const rows = document.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('https://example.com');
    expect(rows[0].textContent).toContain('A short preview of the selected document.');
    expect(rows[0].textContent).toContain('done');

    const openBtn = rows[0].querySelectorAll('button')[0];
    openBtn.click();
    expect(alertMock).toHaveBeenCalledWith(expect.stringContaining('re-picking'));

    const reprocessBtn = rows[0].querySelectorAll('button')[1];
    reprocessBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Reprocess'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'reprocessRecord', key: 'rec1' },
      expect.any(Function),
    );

    const deleteBtn = Array.from(rows[0].querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete',
    );
    deleteBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('all related summaries'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'deleteRecord', key: 'rec1' },
      expect.any(Function),
    );
  });

  it('shows a stop action for in-flight records', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'rec1',
              sourceUrl: 'https://example.com',
              createdAt: 1716972000000,
              status: 'summarizing',
            },
          ],
        });
      } else if (msg.type === 'cancelRecordProcessing') {
        cb({ ok: true });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });

    const stopBtn = Array.from(document.querySelectorAll('tbody tr button')).find(
      (button) => button.textContent === 'Stop',
    );
    expect(stopBtn).not.toBeUndefined();

    stopBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Stop processing'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'cancelRecordProcessing', key: 'rec1' },
      expect.any(Function),
    );
  });

  it('offers the same retry dialog for a cancelled record', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'cancelled-1',
              sourceUrl: 'https://example.com',
              createdAt: 1716972000000,
              status: 'cancelled',
              error: 'Processing stopped.',
            },
          ],
        });
      } else if (msg.type === 'retryRecord') {
        cb({ ok: true });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('.status.cancelled.status-button')).not.toBeNull();
    });
    expect(
      Array.from(document.querySelectorAll('tbody tr button')).some(
        (button) => button.textContent === 'Open',
      ),
    ).toBe(false);

    document.querySelector('.status.cancelled.status-button').click();
    await waitFor(() => {
      expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
    });
    document.querySelector('.pagetollm-spinner-retry-btn').click();
    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'retryRecord', key: 'cancelled-1' },
        expect.any(Function),
      );
    });
  });

  it('opens summary errors from needs-attention status and can skip them', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'attention-1',
              sourceUrl: 'https://example.com/attention',
              createdAt: 1716972000000,
              status: 'needs_attention',
              summaryErrors: [{ topic: 'Tech>AI', error_message: 'Timed out' }],
            },
          ],
        });
      } else if (msg.type === 'resolveSummaryErrors') {
        cb({ ok: true });
      } else if (msg.type === 'getRecord') {
        cb({
          ok: true,
          record: {
            key: 'attention-1',
            sourceUrl: 'https://example.com/attention',
            status: 'needs_attention',
            summaryErrors: [{ topic: 'Tech>AI', error_message: 'Timed out' }],
          },
        });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });

    const statusButton = document.querySelector('.status.needs_attention.status-button');
    expect(statusButton.textContent).toContain('needs attention');
    expect(
      Array.from(document.querySelectorAll('tbody tr button')).some(
        (button) => button.textContent === 'Open',
      ),
    ).toBe(false);
    statusButton.click();

    await waitFor(() => {
      expect(document.querySelector('.pagetollm-summary-errors-list')).not.toBeNull();
    });
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'getRecord', key: 'attention-1' },
      expect.any(Function),
    );
    expect(document.querySelector('.pagetollm-options-error-overlay').textContent).toContain(
      'Tech>AI',
    );
    document.querySelector('.pagetollm-spinner-skip-btn').click();

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'resolveSummaryErrors', key: 'attention-1', action: 'skip' },
        expect.any(Function),
      );
    });
  });

  it('shows a generate-summaries action for done records with missing summary work', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'nosum',
              sourceUrl: 'https://example.com/nosum',
              createdAt: 1716972000000,
              status: 'done',
              summariesDisabled: true,
            },
            {
              key: 'withsum',
              sourceUrl: 'https://example.com/withsum',
              createdAt: 1716972000000,
              status: 'done',
              summariesDisabled: false,
            },
            {
              key: 'partial',
              sourceUrl: 'https://example.com/partial',
              createdAt: 1716972000000,
              status: 'done',
              summariesDisabled: false,
              summariesIncomplete: true,
            },
          ],
        });
      } else if (msg.type === 'generateRecordSummaries') {
        cb({ ok: true });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelectorAll('tbody tr')).toHaveLength(3);
    });

    const rows = document.querySelectorAll('tbody tr');
    const generateBtnIn = (row) =>
      Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent === 'Generate summaries',
      );

    expect(generateBtnIn(rows[1])).toBeUndefined();
    expect(generateBtnIn(rows[2])).not.toBeUndefined();

    const generateBtn = generateBtnIn(rows[0]);
    expect(generateBtn).not.toBeUndefined();
    generateBtn.click();
    // Additive action: no confirm dialog, straight to the runtime message.
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'generateRecordSummaries', key: 'nosum' },
      expect.any(Function),
    );
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('surfaces a stale generate-summaries action instead of refreshing as success', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'partial',
              sourceUrl: 'https://example.com/partial',
              status: 'done',
              summariesIncomplete: true,
            },
          ],
        });
      } else if (msg.type === 'generateRecordSummaries') {
        cb({ ok: true, stale: true });
      } else if (msg.type === 'listProviders') {
        cb({ ok: true, providers: [], activeId: null });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });

    Array.from(document.querySelectorAll('tbody tr button'))
      .find((button) => button.textContent === 'Generate summaries')
      .click();

    await waitFor(() => {
      expect(document.querySelector('#content').textContent).toContain(
        'This record has already been handled.',
      );
    });
  });

  it('exports a full stored record data JSON file', async () => {
    const createObjectURLMock = vi.fn(() => 'blob:data-json');
    const revokeObjectURLMock = vi.fn();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectURLMock,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: revokeObjectURLMock,
    });
    const clickMock = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      const record = {
        key: 'rec1',
        sourceUrl: 'https://example.com/post',
        html: '<p>raw html</p>',
        text: 'raw text',
        sentences: [{ text: 'raw sentence' }],
        status: 'done',
        topics: [{ name: 'Topic', sentences: [1] }],
        topic_summaries: { Topic: { text: 'raw summary' } },
        topic_summary_index: ['Topic'],
        createdAt: 1716972000000,
      };

      sendMessageMock.mockImplementation((msg, cb) => {
        if (msg.type === 'listRecords') {
          cb({
            ok: true,
            items: [
              {
                key: 'rec1',
                sourceUrl: record.sourceUrl,
                createdAt: record.createdAt,
                status: record.status,
              },
            ],
          });
        } else if (msg.type === 'getRecord') {
          cb({ ok: true, record });
        } else if (msg.type === 'listProviders') {
          cb({ ok: true, providers: [], activeId: null });
        }
      });

      await import('./main.jsx');
      await waitFor(() => {
        expect(document.querySelector('tbody tr')).not.toBeNull();
      });

      const row = document.querySelector('tbody tr');
      const exportBtn = Array.from(row.querySelectorAll('button')).find(
        (button) => button.textContent === 'Export data',
      );
      exportBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'getRecord', key: 'rec1' },
        expect.any(Function),
      );
      const exported = JSON.parse(await createObjectURLMock.mock.calls[0][0].text());
      expect(exported).toEqual(record);
      expect(clickMock).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:data-json');
    } finally {
      clickMock.mockRestore();
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, 'revokeObjectURL', {
        configurable: true,
        value: originalRevokeObjectURL,
      });
    }
  });

  it('imports a full record data JSON file without preserving in-flight status', async () => {
    const record = {
      key: 'rec1',
      sourceUrl: 'https://example.com/post',
      html: '<p>raw html</p>',
      text: 'raw text',
      sentences: [{ text: 'raw sentence' }],
      status: 'summarizing',
      topics: [{ name: 'Topic', sentences: [1] }],
      topic_summaries: { Topic: { text: 'raw summary' } },
      topic_summary_index: { Topic: { level: 0, runs: [] } },
      createdAt: 1716972000000,
    };

    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({ ok: true, items: [] });
      } else if (msg.type === 'importRecords') {
        cb({ ok: true, count: msg.records.length });
      } else if (msg.type === 'listProviders') {
        cb({ ok: true, providers: [], activeId: null });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
      const importButton = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Import data',
      );
      expect(importButton.disabled).toBe(false);
    });

    const file = new File([JSON.stringify(record)], 'pagetollm-data-rec1.json', {
      type: 'application/json',
    });
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(() => {
      expect(sendMessageMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'importRecords' }),
        expect.any(Function),
      );
    });

    const importMessage = sendMessageMock.mock.calls.find(
      ([msg]) => msg.type === 'importRecords',
    )[0];
    expect(importMessage.records).toHaveLength(1);
    expect(importMessage.records[0]).toEqual(
      expect.objectContaining({
        key: 'rec1',
        status: 'done',
        error: null,
        html: '<p>raw html</p>',
        topics: [{ name: 'Topic', sentences: [1] }],
        topic_summaries: { Topic: { text: 'raw summary' } },
        progress: { stage: 'imported', done: 1, total: 1 },
      }),
    );
    expect(document.body.textContent).toContain('Imported 1 record.');
  });

  it('asks before an imported record overwrites an existing key', async () => {
    confirmMock.mockReturnValueOnce(false);
    const record = {
      key: 'rec1',
      sourceUrl: 'https://example.com/post',
      html: '<p>raw html</p>',
      text: 'raw text',
      status: 'done',
      topics: [{ name: 'Topic', sentences: [1] }],
      topic_summaries: { Topic: { text: 'raw summary' } },
    };

    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'rec1',
              sourceUrl: 'https://example.com/existing',
              createdAt: 1716972000000,
              status: 'done',
            },
          ],
        });
      } else if (msg.type === 'importRecords') {
        cb({ ok: true, count: msg.records.length });
      } else if (msg.type === 'listProviders') {
        cb({ ok: true, providers: [], activeId: null });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('input[type="file"]')).not.toBeNull();
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });

    const file = new File([JSON.stringify(record)], 'pagetollm-data-rec1.json', {
      type: 'application/json',
    });
    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('overwrite 1 existing record'),
    );
    expect(sendMessageMock.mock.calls.some(([msg]) => msg.type === 'importRecords')).toBe(false);
  });

  it('disables import and rejects a file event while the record list is unavailable', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: false, error: 'storage read failed' });
      else if (msg.type === 'listProviders') cb({ ok: true, providers: [], activeId: null });
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('#content').textContent).toContain("Couldn't load records");
    });

    const importButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Import data',
    );
    expect(importButton.disabled).toBe(true);

    const input = document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['{"key":"unseen"}'], 'records.json', { type: 'application/json' })],
    });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      expect(document.body.textContent).toContain('Cannot import while records are unavailable');
    });
    expect(sendMessageMock.mock.calls.some(([msg]) => msg.type === 'importRecords')).toBe(false);
  });

  it('disables import after a refresh fails even when stale records remain visible', async () => {
    let listCalls = 0;
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        listCalls += 1;
        if (listCalls === 1) {
          cb({
            ok: true,
            items: [{ key: 'existing', sourceUrl: 'https://example.com', status: 'done' }],
          });
        } else {
          cb({ ok: false, error: 'refresh failed' });
        }
      } else if (msg.type === 'reprocessRecord') {
        cb({ ok: true });
      } else if (msg.type === 'listProviders') {
        cb({ ok: true, providers: [], activeId: null });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });
    Array.from(document.querySelectorAll('tbody tr button'))
      .find((button) => button.textContent === 'Reprocess')
      .click();
    await waitFor(() => {
      expect(document.querySelector('#content').textContent).toContain("Couldn't refresh records");
    });

    const importButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Import data',
    );
    expect(importButton.disabled).toBe(true);
    expect(document.querySelector('tbody tr').textContent).toContain('https://example.com');
  });

  it('handles empty record list', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({ ok: true, items: [] });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      const empty = document.querySelector('#content .empty');
      expect(empty).not.toBeNull();
      expect(empty.textContent).toContain('No records yet');
    });
  });

  // A failed round-trip must render a distinct error state with a retry
  // affordance, not the same "No records yet" empty state a user with real
  // records could see on a transient failure.
  it('shows a retry affordance instead of "No records yet" when listRecords fails, and recovers on retry', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: false, error: 'storage read failed' });
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('#content').textContent).toContain(
        "Couldn't load records: storage read failed",
      );
    });
    expect(document.querySelector('#content').textContent).not.toContain('No records yet');

    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [{ key: 'rec1', sourceUrl: 'https://example.com', status: 'done' }],
        });
      }
    });
    const retryBtn = Array.from(document.querySelectorAll('#content button')).find(
      (button) => button.textContent === 'Retry',
    );
    expect(retryBtn).not.toBeUndefined();
    retryBtn.click();

    await waitFor(() => {
      expect(document.querySelector('tbody tr')).not.toBeNull();
    });
  });

  // U1's same "empty state hides a real failure" defect on the providers list.
  it('shows a retry affordance instead of "No providers configured yet" when listProviders fails', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') cb({ ok: false, error: 'storage read failed' });
    });

    await import('./main.jsx');
    await waitFor(() => {
      const providersPanel = document.getElementById('options-panel-providers');
      expect(providersPanel.textContent).toContain("Couldn't load providers: storage read failed");
    });
    expect(document.getElementById('options-panel-providers').textContent).not.toContain(
      'No providers configured yet',
    );
  });

  // A failed delete must surface an error instead of silently reloading the
  // (unchanged) provider list.
  it('surfaces an error when deleting a provider fails, and the provider is not silently removed', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            { id: 'p1', name: 'Local', type: 'openai_comp', model: 'm', url: 'http://h' },
          ],
          activeId: 'p1',
        });
      } else if (msg.type === 'deleteProvider') {
        cb({ ok: false, error: 'delete failed' });
      }
    });

    await import('./main.jsx');
    let deleteBtn;
    await waitFor(() => {
      const providerTable = document.querySelectorAll('table')[0];
      deleteBtn = Array.from(providerTable.querySelectorAll('tbody button')).find(
        (b) => b.textContent === 'Delete',
      );
      expect(deleteBtn).not.toBeUndefined();
    });

    deleteBtn.click();
    await waitFor(() => {
      expect(document.getElementById('options-panel-providers').textContent).toContain(
        'delete failed',
      );
    });
    // The provider is still listed - a failed delete must not silently no-op
    // by reloading a list that (correctly) still contains it, without saying why.
    expect(document.querySelectorAll('table')[0].querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('handles deleteAll', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({
          ok: true,
          items: [
            {
              key: 'rec1',
              sourceUrl: 'https://example.com',
              createdAt: 1716972000000,
              status: 'done',
            },
          ],
        });
      } else if (msg.type === 'deleteAll') {
        cb({ ok: true });
      }
    });

    await import('./main.jsx');
    let deleteAllBtn;
    await waitFor(() => {
      deleteAllBtn = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Delete all page data',
      );
      expect(deleteAllBtn).not.toBeUndefined();
    });

    deleteAllBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete ALL page data'));
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'deleteAll' }, expect.any(Function));
  });

  it('lists every storage category and can reset all extension data', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') cb({ ok: true, providers: [], activeId: null });
      else if (msg.type === 'getStorageOverview') {
        cb({
          ok: true,
          overview: {
            totalBytes: 4096,
            totalKeyCount: 8,
            categories: {
              pageData: { bytes: 3000, keyCount: 4, recordCount: 1, chatCount: 1 },
              providers: { bytes: 500, keyCount: 1, providerCount: 1 },
              settings: { bytes: 100, keyCount: 1 },
              diagnostics: { bytes: 400, keyCount: 1 },
              other: { bytes: 96, keyCount: 1 },
            },
          },
        });
      } else if (msg.type === 'deleteAllExtensionData') cb({ ok: true });
    });

    await import('./main.jsx');
    await waitFor(() => {
      expect(document.querySelector('[aria-label="Extension storage categories"]')).not.toBeNull();
    });

    const resetButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Delete all extension data',
    );
    resetButton.click();

    expect(confirmMock).toHaveBeenCalledWith(
      expect.stringContaining('provider settings and API tokens'),
    );
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'deleteAllExtensionData' },
      expect.any(Function),
    );
  });

  it('renders configured providers and marks the active one', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            { id: 'p1', name: 'Local', type: 'openai_comp', model: 'gpt-oss-20B', url: 'http://h' },
            { id: 'p2', name: 'Claude', type: 'anthropic', model: 'claude-haiku-4-5' },
          ],
          activeId: 'p2',
        });
      }
    });

    await import('./main.jsx');
    await waitFor(() => {
      const tables = document.querySelectorAll('table');
      expect(tables.length).toBeGreaterThan(0);
      const providerRows = tables[0].querySelectorAll('tbody tr');
      expect(providerRows).toHaveLength(2);
    });

    const tables = document.querySelectorAll('table');
    const providerRows = tables[0].querySelectorAll('tbody tr');
    expect(providerRows[1].textContent).toContain('Claude');
    expect(providerRows[1].textContent).toContain('Active');

    const radios = document.querySelectorAll('input[type="radio"]');
    expect(radios[1].checked).toBe(true);
  });

  it('adds a provider via the form', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') cb({ ok: true, providers: [], activeId: null });
      else if (msg.type === 'saveProvider') cb({ ok: true, provider: msg.provider });
    });

    await import('./main.jsx');
    await waitFor(() => {
      const addButton = Array.from(document.querySelectorAll('button')).find(
        (button) => button.textContent === 'Add provider',
      );
      expect(addButton).not.toBeUndefined();
    });
    const addButton = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add provider',
    );
    addButton.click();
    await waitFor(() => {
      expect(document.getElementById('provider-name')).not.toBeNull();
    });

    const setValue = (id, value) => {
      const el = document.getElementById(id);
      const setter = Object.getOwnPropertyDescriptor(
        el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype,
        'value',
      ).set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setValue('provider-name', 'My OpenAI');
    setValue('provider-model', 'gpt-4o');
    setValue('provider-token', 'sk-123');
    setValue('provider-service-tier', 'flex');

    document
      .querySelector('.provider-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'saveProvider',
        provider: expect.objectContaining({
          name: 'My OpenAI',
          type: 'openai',
          model: 'gpt-4o',
          token: 'sk-123',
          serviceTier: 'flex',
        }),
      }),
      expect.any(Function),
    );
  });

  it('warns and wipes the stored token when an openai_comp URL changes with a blank token', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            {
              id: 'p1',
              name: 'Local',
              type: 'openai_comp',
              model: 'm',
              url: 'http://h',
              hasToken: true,
            },
          ],
          activeId: 'p1',
        });
      } else if (msg.type === 'saveProvider') cb({ ok: true, provider: msg.provider });
    });

    await import('./main.jsx');
    await waitFor(() => {
      const editBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Edit',
      );
      expect(editBtn).not.toBeUndefined();
    });

    const setValue = (id, value) => {
      const el = document.getElementById(id);
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const editBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    );
    editBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    setValue('provider-url', 'http://h2');
    sendMessageMock.mockClear();

    document
      .querySelector('.provider-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('wipe the stored token'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'saveProvider',
        provider: expect.objectContaining({
          id: 'p1',
          url: 'http://h2',
          token: '',
        }),
      }),
      expect.any(Function),
    );
  });

  it('does not save an openai_comp URL change when token wipe is canceled', async () => {
    confirmMock.mockReturnValueOnce(false);
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            {
              id: 'p1',
              name: 'Local',
              type: 'openai_comp',
              model: 'm',
              url: 'http://h',
              hasToken: true,
            },
          ],
          activeId: 'p1',
        });
      } else if (msg.type === 'saveProvider') cb({ ok: true, provider: msg.provider });
    });

    await import('./main.jsx');
    await waitFor(() => {
      const editBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Edit',
      );
      expect(editBtn).not.toBeUndefined();
    });

    const editBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Edit',
    );
    editBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const urlEl = document.getElementById('provider-url');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(urlEl, 'http://h2');
    urlEl.dispatchEvent(new Event('input', { bubbles: true }));
    urlEl.dispatchEvent(new Event('change', { bubbles: true }));
    sendMessageMock.mockClear();

    document
      .querySelector('.provider-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('wipe the stored token'));
    expect(sendMessageMock.mock.calls.some(([msg]) => msg.type === 'saveProvider')).toBe(false);
  });

  it('activates and deletes providers', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') cb({ ok: true, items: [] });
      else if (msg.type === 'listProviders') {
        cb({
          ok: true,
          providers: [
            { id: 'p1', name: 'Local', type: 'openai_comp', model: 'm', url: 'http://h' },
          ],
          activeId: 'p1',
        });
      } else if (msg.type === 'deleteProvider') cb({ ok: true, providers: [], activeId: null });
    });

    await import('./main.jsx');
    await waitFor(() => {
      const tables = document.querySelectorAll('table');
      expect(tables.length).toBeGreaterThan(0);
      const providerTable = tables[0];
      const buttons = providerTable.querySelectorAll('tbody button');
      const deleteBtn = Array.from(buttons).find((b) => b.textContent === 'Delete');
      expect(deleteBtn).not.toBeUndefined();
    });

    const providerTable = document.querySelectorAll('table')[0];
    const buttons = providerTable.querySelectorAll('tbody button');
    const deleteBtn = Array.from(buttons).find((b) => b.textContent === 'Delete');
    deleteBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete this provider'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'deleteProvider', id: 'p1' },
      expect.any(Function),
    );
  });
});
