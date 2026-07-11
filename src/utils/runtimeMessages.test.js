// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendRuntimeMessage, sendTabMessage } from './runtimeMessages.js';

describe('runtimeMessages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('sendRuntimeMessage', () => {
    it('resolves with the raw response on success', async () => {
      const sendMessage = vi.fn((msg, cb) => cb({ ok: true, items: [1, 2] }));
      vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: null } });

      const res = await sendRuntimeMessage({ type: 'test' });
      expect(res).toEqual({ ok: true, items: [1, 2] });
      expect(sendMessage).toHaveBeenCalledWith({ type: 'test' }, expect.any(Function));
    });

    it('rejects with an Error built from chrome.runtime.lastError.message', async () => {
      vi.stubGlobal('chrome', {
        runtime: {
          sendMessage: vi.fn((msg, cb) => {
            chrome.runtime.lastError = { message: 'disconnected' };
            cb();
            chrome.runtime.lastError = null;
          }),
          lastError: null,
        },
      });

      await expect(sendRuntimeMessage({ type: 'test' })).rejects.toThrow('disconnected');
    });
  });

  describe('sendTabMessage', () => {
    it('resolves with the raw response and passes tabId through', async () => {
      const sendMessage = vi.fn((tabId, msg, cb) => cb({ status: 'ok' }));
      vi.stubGlobal('chrome', {
        runtime: { lastError: null },
        tabs: { sendMessage },
      });

      const res = await sendTabMessage(42, { action: 'test' });
      expect(res).toEqual({ status: 'ok' });
      expect(sendMessage).toHaveBeenCalledWith(42, { action: 'test' }, expect.any(Function));
    });

    it('rejects with an Error built from chrome.runtime.lastError.message', async () => {
      vi.stubGlobal('chrome', {
        runtime: { lastError: null },
        tabs: {
          sendMessage: vi.fn((tabId, msg, cb) => {
            chrome.runtime.lastError = { message: 'tab closed' };
            cb();
            chrome.runtime.lastError = null;
          }),
        },
      });

      await expect(sendTabMessage(1, { action: 'test' })).rejects.toThrow('tab closed');
    });
  });
});
