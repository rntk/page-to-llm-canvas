// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserFileHost, browserPageHost, browserScheduler } from './browserHosts.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('browser host capabilities', () => {
  it('schedules and cancels timeouts through the scheduler', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    const cancelled = vi.fn();
    browserScheduler.setTimeout(fired, 25);
    browserScheduler.clearTimeout(browserScheduler.setTimeout(cancelled, 25));
    vi.advanceTimersByTime(25);
    expect(fired).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('opens extension pages only when the browser URL capability exists', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    vi.stubGlobal('chrome', undefined);
    expect(browserPageHost.openExtensionPage('modal.html?key=a')).toBe(false);

    vi.stubGlobal('chrome', {
      runtime: { getURL: (path) => `chrome-extension://test/${path}` },
    });
    expect(browserPageHost.openExtensionPage('modal.html?key=a')).toBe(true);
    expect(open).toHaveBeenCalledWith('chrome-extension://test/modal.html?key=a', '_blank');
  });

  it('reads JSON files without exposing File or DOM details to consumers', async () => {
    const file = { text: vi.fn().mockResolvedValue('{"ok":true}') };
    await expect(browserFileHost.readJson(file)).resolves.toEqual({ ok: true });
    await expect(browserFileHost.readJson(null)).rejects.toThrow('No file selected');
  });
});
