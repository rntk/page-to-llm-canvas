import { describe, it, expect, vi } from 'vitest';
import { MSG } from '../../../shared/runtime/messages.js';
import { createNavigationHandlers } from './navigationHandlers.js';

describe('createNavigationHandlers', () => {
  it('exposes openOptionsPage to content scripts', () => {
    const handlers = createNavigationHandlers({ openOptionsPage: vi.fn() });
    expect(handlers[MSG.openOptionsPage].requiresExtensionPage).toBe(false);
    expect(handlers[MSG.openOptionsPage].validate({})).toBeNull();
  });

  it('opens the Options page and reports ok', async () => {
    const openOptionsPage = vi.fn(async () => {});
    const handlers = createNavigationHandlers({ openOptionsPage });
    await expect(handlers[MSG.openOptionsPage].handle({}, {})).resolves.toEqual({ ok: true });
    expect(openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('propagates a browser failure so dispatch reports it', async () => {
    const handlers = createNavigationHandlers({
      openOptionsPage: async () => {
        throw new Error('no options page');
      },
    });
    await expect(handlers[MSG.openOptionsPage].handle({}, {})).rejects.toThrow('no options page');
  });
});
