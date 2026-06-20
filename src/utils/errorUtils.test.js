import { describe, it, expect, vi, afterEach } from 'vitest';
import { splitError, retryRecord, resolveSummaryErrors } from './errorUtils.js';

describe('errorUtils', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty strings for falsy inputs', () => {
    expect(splitError(null)).toEqual({ message: '', details: '' });
    expect(splitError(undefined)).toEqual({ message: '', details: '' });
    expect(splitError('')).toEqual({ message: '', details: '' });
  });

  it('handles single-line errors', () => {
    expect(splitError('Something failed')).toEqual({
      message: 'Something failed',
      details: '',
    });
  });

  it('handles multi-line errors by splitting on the first newline', () => {
    expect(splitError('Something failed\nat step 1\nat step 2')).toEqual({
      message: 'Something failed',
      details: 'at step 1\nat step 2',
    });
  });

  it('hardens non-string inputs by coercing them to strings', () => {
    expect(splitError(new Error('error msg'))).toEqual({
      message: 'Error: error msg',
      details: '',
    });
    expect(splitError(12345)).toEqual({
      message: '12345',
      details: '',
    });
    expect(splitError(0)).toEqual({
      message: '0',
      details: '',
    });
    expect(splitError(false)).toEqual({
      message: 'false',
      details: '',
    });
  });

  describe('retryRecord', () => {
    it('resolves on successful runtime response', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: true }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      const res = await retryRecord('key1', 'Test');
      expect(res).toEqual({ ok: true });
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'retryRecord', key: 'key1' },
        expect.any(Function),
      );
    });

    it('rejects on runtime.lastError', async () => {
      const sendMessageMock = vi.fn((msg, cb) => {
        chrome.runtime.lastError = { message: 'runtime error message' };
        cb(null);
        delete chrome.runtime.lastError;
      });
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(retryRecord('key1', 'Test')).rejects.toThrow('runtime error message');
    });

    it('rejects on response failure (ok: false)', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: false, error: 'some backend error' }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(retryRecord('key1', 'Test')).rejects.toThrow('some backend error');
    });

    it('rejects with a fallback message when response has no error field', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: false }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(retryRecord('key1', 'Test')).rejects.toThrow('Retry failed');
    });
  });

  describe('resolveSummaryErrors', () => {
    it('resolves on successful runtime response', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: true }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      const res = await resolveSummaryErrors('key1', 'retry', 'Hierarchy');
      expect(res).toEqual({ ok: true });
      expect(sendMessageMock).toHaveBeenCalledWith(
        { type: 'resolveSummaryErrors', key: 'key1', action: 'retry' },
        expect.any(Function),
      );
    });

    it('rejects on runtime.lastError', async () => {
      const sendMessageMock = vi.fn((msg, cb) => {
        chrome.runtime.lastError = { message: 'resolve runtime error' };
        cb(null);
        delete chrome.runtime.lastError;
      });
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(resolveSummaryErrors('key1', 'skip', 'Hierarchy')).rejects.toThrow(
        'resolve runtime error',
      );
    });

    it('rejects on response failure (ok: false)', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: false, error: 'resolve backend error' }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(resolveSummaryErrors('key1', 'skip')).rejects.toThrow('resolve backend error');
    });

    it('rejects with a fallback message when response has no error field', async () => {
      const sendMessageMock = vi.fn((msg, cb) => cb({ ok: false }));
      vi.stubGlobal('chrome', { runtime: { sendMessage: sendMessageMock } });

      await expect(resolveSummaryErrors('key1', 'retry')).rejects.toThrow('Resolve failed');
    });
  });
});
