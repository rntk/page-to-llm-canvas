import { describe, it, expect, vi } from 'vitest';
import {
  OPEN_GROUP_PROJECT_COMMAND,
  OPEN_GROUP_PROJECT_MENU_ID,
  createCoalescedRunner,
  createProjectMenus,
  createProjectService,
  installProjectRuntime,
} from './projects.js';
import { createProjectStore } from '../../core/projects/projectStorage.js';

const BASE = 'chrome-extension://ext/project.html';

/** In-memory browser: tabs and groups the fake APIs read and mutate. */
function makeBrowser({ groups = [], tabs = [] } = {}) {
  const state = { groups: [...groups], tabs: [...tabs], nextTabId: 100 };
  const api = {
    tabs: {
      query: vi.fn(async () => state.tabs.map((t) => ({ ...t }))),
      create: vi.fn(async (props) => {
        const created = { id: state.nextTabId++, groupId: -1, index: props.index ?? 0, ...props };
        state.tabs.push(created);
        return created;
      }),
      update: vi.fn(async () => ({})),
      group: vi.fn(async ({ groupId, tabIds }) => {
        for (const t of state.tabs) if (tabIds.includes(t.id)) t.groupId = groupId;
        return groupId;
      }),
    },
    tabGroups: {
      query: vi.fn(async () => state.groups.map((g) => ({ ...g }))),
      get: vi.fn(async (id) => state.groups.find((g) => g.id === id)),
    },
    windows: { update: vi.fn(async () => ({})) },
  };
  return { state, api };
}

function makeService(browser, { stored = [], trusted = true } = {}) {
  const data = { projects: stored };
  const projectStore = createProjectStore({
    key: 'projects',
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => Object.assign(data, items),
    queue: (_key, fn) => fn(),
  });
  let ids = 0;
  const bindingSession = {
    isTrusted: vi.fn(async () => trusted),
    markTrusted: vi.fn(async () => {}),
  };
  const service = createProjectService({
    ...browser.api,
    getURL: (path) => `chrome-extension://ext/${path}`,
    projectStore,
    bindingSession,
    now: () => 1000,
    createId: () => `p${++ids}`,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { service, data, bindingSession };
}

const group = (id, title = 'Work', windowId = 1) => ({ id, title, color: 'blue', windowId });
const tab = (id, groupId, index, extra = {}) => ({
  id,
  groupId,
  index,
  windowId: 1,
  title: `Tab ${id}`,
  url: `https://example.com/${id}`,
  ...extra,
});
const stored = (id, groupId, title = 'Work') => ({
  id,
  title,
  color: 'blue',
  groupId,
  createdAt: 1,
  updatedAt: 1,
});

describe('openProjectForGroup', () => {
  it('creates a project and its page tab after the group', async () => {
    const browser = makeBrowser({
      groups: [group(7)],
      tabs: [tab(1, 7, 0), tab(2, 7, 1), tab(3, -1, 2)],
    });
    const { service, data } = makeService(browser);

    const result = await service.openProjectForGroup(7);

    expect(result).toMatchObject({ createdProject: true, createdTab: true, tabId: 100 });
    expect(data.projects).toEqual([
      expect.objectContaining({ id: 'p1', groupId: 7, title: 'Work' }),
    ]);
    expect(browser.api.tabs.create).toHaveBeenCalledWith({
      url: `${BASE}?id=p1`,
      windowId: 1,
      index: 2,
      active: true,
    });
    expect(browser.api.tabs.group).toHaveBeenCalledWith({ groupId: 7, tabIds: [100] });
    expect(browser.api.windows.update).toHaveBeenCalledWith(1, { focused: true });
  });

  it('focuses an existing project tab instead of creating one', async () => {
    const browser = makeBrowser({
      groups: [group(7)],
      tabs: [tab(1, 7, 0), tab(5, 7, 1, { url: `${BASE}?id=a`, windowId: 2 })],
    });
    const { service } = makeService(browser, { stored: [stored('a', 7)] });

    const result = await service.openProjectForGroup(7);

    expect(result).toMatchObject({ createdProject: false, createdTab: false, tabId: 5 });
    expect(browser.api.tabs.create).not.toHaveBeenCalled();
    expect(browser.api.tabs.update).toHaveBeenCalledWith(5, { active: true });
    expect(browser.api.windows.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it('rejects unknown groups', async () => {
    const { service } = makeService(makeBrowser());
    await expect(service.openProjectForGroup(3)).rejects.toThrow('tab group not found');
  });

  it('does nothing for ungrouped tabs', async () => {
    const browser = makeBrowser();
    const { service } = makeService(browser);
    expect(await service.openProjectForTab({ id: 1, groupId: -1 })).toBeNull();
    expect(browser.api.tabs.create).not.toHaveBeenCalled();
  });
});

describe('rebinding through the service', () => {
  it('rebinds after a restart via the project tab and marks the session trusted', async () => {
    const browser = makeBrowser({
      groups: [group(3, 'Other'), group(55, 'Renamed')],
      tabs: [tab(9, 55, 0, { url: `${BASE}?id=a` })],
    });
    const { service, data, bindingSession } = makeService(browser, {
      stored: [stored('a', 3)],
      trusted: false,
    });

    await service.sync();

    expect(data.projects[0]).toMatchObject({ groupId: 55, title: 'Renamed' });
    expect(bindingSession.markTrusted).toHaveBeenCalled();
  });

  it('unbinds removed groups', async () => {
    const { service, data } = makeService(makeBrowser(), { stored: [stored('a', 3)] });
    await service.handleGroupRemoved(3);
    expect(data.projects[0].groupId).toBeNull();
  });
});

describe('overview and view', () => {
  it('lists projects with open state and ungrouped live groups', async () => {
    const browser = makeBrowser({
      groups: [group(7), group(8, 'Loose')],
      tabs: [tab(1, 7, 0), tab(2, 7, 1, { url: `${BASE}?id=a` }), tab(3, 8, 2)],
    });
    const { service } = makeService(browser, {
      stored: [stored('a', 7), stored('b', null, 'Gone')],
    });

    const overview = await service.listProjectsOverview();

    expect(overview.projects).toEqual([
      expect.objectContaining({ id: 'a', isOpen: true, tabCount: 1 }),
      expect.objectContaining({ id: 'b', isOpen: false, tabCount: 0 }),
    ]);
    expect(overview.ungroupedGroups).toEqual([
      { groupId: 8, title: 'Loose', color: 'blue', windowId: 1, tabCount: 1 },
    ]);
  });

  it('returns group tabs in index order without the project page tab', async () => {
    const browser = makeBrowser({
      groups: [group(7)],
      tabs: [
        tab(2, 7, 3),
        tab(1, 7, 1, { active: true, status: 'complete' }),
        tab(4, 7, 2, { url: `${BASE}?id=a` }),
      ],
    });
    const { service } = makeService(browser, { stored: [stored('a', 7)] });

    const view = await service.getProjectView('a');

    expect(view.isOpen).toBe(true);
    expect(view.tabs.map((t) => t.id)).toEqual([1, 2]);
    expect(view.tabs[0]).toEqual({
      id: 1,
      title: 'Tab 1',
      url: 'https://example.com/1',
      favIconUrl: '',
      active: true,
      index: 1,
      status: 'complete',
    });
  });

  it('reports closed projects with no tabs and rejects unknown ids', async () => {
    const { service } = makeService(makeBrowser(), { stored: [stored('a', null)] });
    expect(await service.getProjectView('a')).toMatchObject({ isOpen: false, tabs: [] });
    await expect(service.getProjectView('zzz')).rejects.toThrow('project not found');
  });
});

describe('openProject / focusGroup / deleteProject', () => {
  it('opens a closed project in a standalone tab', async () => {
    const browser = makeBrowser();
    const { service } = makeService(browser, { stored: [stored('a', null)] });
    const result = await service.openProject('a');
    expect(result).toMatchObject({ isOpen: false, createdTab: true });
    expect(browser.api.tabs.create).toHaveBeenCalledWith({ url: `${BASE}?id=a`, active: true });
    expect(browser.api.tabs.group).not.toHaveBeenCalled();
  });

  it('opens a live project inside its group', async () => {
    const browser = makeBrowser({ groups: [group(7)], tabs: [tab(1, 7, 0)] });
    const { service } = makeService(browser, { stored: [stored('a', 7)] });
    expect(await service.openProject('a')).toMatchObject({ isOpen: true, createdTab: true });
    expect(browser.api.tabs.group).toHaveBeenCalledWith({ groupId: 7, tabIds: [100] });
  });

  it('focuses the group project tab, or reports a closed group', async () => {
    const browser = makeBrowser({
      groups: [group(7)],
      tabs: [tab(1, 7, 0), tab(2, 7, 1, { url: `${BASE}?id=a` })],
    });
    const { service } = makeService(browser, { stored: [stored('a', 7), stored('b', null, 'B')] });
    expect(await service.focusGroup('a')).toEqual({ isOpen: true, tabId: 2 });
    expect(await service.focusGroup('b')).toEqual({ isOpen: false, tabId: null });
  });

  it('deletes only storage', async () => {
    const browser = makeBrowser({ groups: [group(7)], tabs: [tab(1, 7, 0)] });
    const { service, data } = makeService(browser, { stored: [stored('a', 7)] });
    expect(await service.deleteProject('a')).toEqual({ deleted: true });
    expect(await service.deleteProject('a')).toEqual({ deleted: false });
    expect(data.projects).toEqual([]);
    expect(browser.api.tabs.update).not.toHaveBeenCalled();
  });
});

describe('createCoalescedRunner', () => {
  it('runs at most one extra pass for a burst', async () => {
    const run = vi.fn(async () => {});
    const schedule = createCoalescedRunner(run);
    const first = schedule();
    schedule();
    schedule();
    await first;
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('createProjectMenus', () => {
  function makeMenus(contextType) {
    return {
      ...(contextType ? { ContextType: contextType } : {}),
      removeAll: vi.fn(async () => {}),
      create: vi.fn((_props, cb) => cb()),
    };
  }

  it('uses page and action contexts where tab is unsupported', async () => {
    const menus = makeMenus({ PAGE: 'page', ACTION: 'action' });
    await createProjectMenus(menus);
    expect(menus.removeAll).toHaveBeenCalled();
    expect(menus.create).toHaveBeenCalledWith(
      { id: OPEN_GROUP_PROJECT_MENU_ID, title: 'Open group project', contexts: ['page', 'action'] },
      expect.any(Function),
    );
  });

  it('adds the tab context when the browser supports it', async () => {
    const menus = makeMenus({ PAGE: 'page', TAB: 'tab' });
    await createProjectMenus(menus);
    expect(menus.create.mock.calls[0][0].contexts).toEqual(['page', 'action', 'tab']);
  });

  it('falls back when the tab context throws', async () => {
    const menus = makeMenus({ TAB: 'tab' });
    menus.create.mockImplementationOnce(() => {
      throw new Error('bad context');
    });
    await createProjectMenus(menus);
    expect(menus.create.mock.calls[1][0].contexts).toEqual(['page', 'action']);
  });
});

describe('installProjectRuntime', () => {
  const event = () => {
    const listeners = [];
    return { listeners, addListener: vi.fn((fn) => listeners.push(fn)) };
  };

  function install() {
    const projectService = {
      sync: vi.fn(async () => {}),
      openProjectForTab: vi.fn(async () => null),
      handleGroupRemoved: vi.fn(async () => {}),
      isProjectPageUrl: (url) => typeof url === 'string' && url.startsWith(BASE),
    };
    const chromeApis = {
      chromeRuntime: { onInstalled: event(), onStartup: event() },
      chromeTabs: {
        onUpdated: event(),
        onAttached: event(),
        query: vi.fn(async () => [{ id: 3, groupId: 4 }]),
      },
      chromeTabGroups: { onCreated: event(), onUpdated: event(), onRemoved: event() },
      chromeContextMenus: {
        onClicked: event(),
        removeAll: vi.fn(async () => {}),
        create: vi.fn((_p, cb) => cb()),
      },
      chromeCommands: { onCommand: event() },
    };
    installProjectRuntime({ projectService, ...chromeApis, logger: { warn: vi.fn() } });
    return { projectService, ...chromeApis };
  }

  it('tolerates a browser without any project APIs', () => {
    expect(() => installProjectRuntime({ projectService: {} })).not.toThrow();
  });

  it('creates menus and rebinds on install', async () => {
    const { chromeRuntime, chromeContextMenus, projectService } = install();
    chromeRuntime.onInstalled.listeners[0]();
    await vi.waitFor(() => expect(chromeContextMenus.create).toHaveBeenCalled());
    expect(projectService.sync).toHaveBeenCalled();
  });

  it('opens the group project from the menu and the command', async () => {
    const { chromeContextMenus, chromeCommands, projectService } = install();
    const clickedTab = { id: 1, groupId: 2 };
    chromeContextMenus.onClicked.listeners[0](
      { menuItemId: OPEN_GROUP_PROJECT_MENU_ID },
      clickedTab,
    );
    chromeContextMenus.onClicked.listeners[0]({ menuItemId: 'other' }, clickedTab);
    expect(projectService.openProjectForTab).toHaveBeenCalledTimes(1);
    expect(projectService.openProjectForTab).toHaveBeenCalledWith(clickedTab);

    chromeCommands.onCommand.listeners[0](OPEN_GROUP_PROJECT_COMMAND);
    await vi.waitFor(() =>
      expect(projectService.openProjectForTab).toHaveBeenCalledWith({ id: 3, groupId: 4 }),
    );
  });

  it('rebinds only on project page loads and group changes', () => {
    const { chromeTabs, chromeTabGroups, projectService } = install();
    chromeTabs.onUpdated.listeners[0](1, { url: 'https://example.com' });
    chromeTabs.onUpdated.listeners[0](1, { status: 'complete' });
    expect(projectService.sync).not.toHaveBeenCalled();
    chromeTabs.onUpdated.listeners[0](1, { url: `${BASE}?id=a` });
    expect(projectService.sync).toHaveBeenCalledTimes(1);
    chromeTabGroups.onRemoved.listeners[0]({ id: 6 });
    expect(projectService.handleGroupRemoved).toHaveBeenCalledWith(6);
  });
});
