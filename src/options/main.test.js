// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

    const rootEl = document.createElement('div');
    rootEl.id = 'options-root';
    document.body.appendChild(rootEl);

    sendMessageMock = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: sendMessageMock,
      },
    });

    confirmMock = vi.fn(() => true);
    alertMock = vi.fn();
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('alert', alertMock);
  });

  afterEach(() => {
    const rootEl = document.getElementById('options-root');
    if (rootEl) rootEl.remove();
    vi.unstubAllGlobals();
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

    const deleteBtn = rows[0].querySelectorAll('button')[3];
    deleteBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete this record'));
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'deleteRecord', key: 'rec1' },
      expect.any(Function),
    );
  });

  it('exports a stored record metadata JSON file without raw content fields', async () => {
    const createObjectURLMock = vi.fn(() => 'blob:metadata-json');
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
        status: 'done',
        selectors: ['main article'],
        topics: [{ name: 'Topic', sentences: [1] }],
        processingLog: [{ stage: 'pipeline_start' }],
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
        (button) => button.textContent === 'Export metadata',
      );
      exportBtn.click();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'getRecord', key: 'rec1' },
        expect.any(Function),
      );
      expect(createObjectURLMock).toHaveBeenCalledWith(expect.any(Blob));
      const blob = createObjectURLMock.mock.calls[0][0];
      const exported = JSON.parse(await blob.text());
      expect(exported).toEqual({
        key: 'rec1',
        sourceUrl: 'https://example.com/post',
        status: 'done',
        selectors: ['main article'],
        topics: [{ name: 'Topic', sentences: [1] }],
        processingLog: [{ stage: 'pipeline_start' }],
        createdAt: 1716972000000,
      });
      expect(exported).not.toHaveProperty('html');
      expect(exported).not.toHaveProperty('text');
      expect(clickMock).toHaveBeenCalledTimes(1);
      expect(revokeObjectURLMock).toHaveBeenCalledWith('blob:metadata-json');
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

  it('handles empty record list', async () => {
    sendMessageMock.mockImplementation((msg, cb) => {
      if (msg.type === 'listRecords') {
        cb({ ok: true, items: [] });
      }
    });

    await import('./main.jsx');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const empty = document.querySelector('#content .empty');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('No records yet');
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    const deleteAllBtn = document.querySelector('.danger');
    expect(deleteAllBtn).not.toBeNull();

    deleteAllBtn.click();
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('Delete ALL records'));
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'deleteAll' }, expect.any(Function));
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
    await new Promise((resolve) => setTimeout(resolve, 50));

    const tables = document.querySelectorAll('table');
    const providerRows = tables[0].querySelectorAll('tbody tr');
    expect(providerRows).toHaveLength(2);
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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
    await new Promise((resolve) => setTimeout(resolve, 50));

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
