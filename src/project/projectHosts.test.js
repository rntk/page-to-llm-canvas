import { describe, expect, it, vi } from 'vitest';
import { createProjectHosts } from './projectHosts.js';

describe('createProjectHosts', () => {
  it('activates the tab then focuses its window', async () => {
    const chromeApi = {
      tabs: { update: vi.fn(async () => ({ id: 5, windowId: 9 })) },
      windows: { update: vi.fn(async () => ({})) },
    };
    await createProjectHosts(chromeApi).tabsHost.activateTab(5);
    expect(chromeApi.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(chromeApi.windows.update).toHaveBeenCalledWith(9, { focused: true });
  });

  it('skips window focus when windows API is unavailable', async () => {
    const chromeApi = { tabs: { update: vi.fn(async () => ({ id: 5, windowId: 9 })) } };
    await expect(createProjectHosts(chromeApi).tabsHost.activateTab(5)).resolves.toBeUndefined();
  });

  it('opens the options page through the runtime', () => {
    const chromeApi = { runtime: { openOptionsPage: vi.fn() } };
    createProjectHosts(chromeApi).pageHost.openOptions();
    expect(chromeApi.runtime.openOptionsPage).toHaveBeenCalled();
  });
});
