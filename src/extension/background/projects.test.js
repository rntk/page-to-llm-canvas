import { describe, it, expect, vi } from 'vitest';
import {
  OPEN_EXCERPT_MENU_ID,
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
      remove: vi.fn(async (id) => {
        state.tabs = state.tabs.filter((t) => t.id !== id);
      }),
      group: vi.fn(async ({ groupId, tabIds }) => {
        if (groupId === undefined) {
          groupId = Math.max(0, ...state.groups.map((g) => g.id)) + 1;
          const source = state.tabs.find((t) => tabIds.includes(t.id));
          state.groups.push({ id: groupId, title: '', color: 'grey', windowId: source.windowId });
        }
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

function makeService(browser, { stored = [], bindingSession, onRebound } = {}) {
  const data = { projects: stored };
  const projectStore = createProjectStore({
    key: 'projects',
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => Object.assign(data, items),
    queue: (_key, fn) => fn(),
  });
  let ids = 0;
  const service = createProjectService({
    ...browser.api,
    getURL: (path) => `chrome-extension://ext/${path}`,
    projectStore,
    ...(bindingSession ? { bindingSession } : {}),
    ...(onRebound ? { onRebound } : {}),
    now: () => 1000,
    createId: () => `p${++ids}`,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { service, data };
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

  it.each([-1, undefined])(
    'creates a group and project for a tab with groupId %s',
    async (groupId) => {
      const source = tab(1, groupId, 2, { windowId: 4 });
      const browser = makeBrowser({ tabs: [source, tab(2, -1, 3)] });
      const { service, data } = makeService(browser);

      const result = await service.openProjectForTab(source);

      expect(result).toMatchObject({ createdProject: true, createdTab: true, tabId: 100 });
      expect(browser.api.tabs.group).toHaveBeenNthCalledWith(1, { tabIds: [1] });
      expect(browser.api.tabs.group).toHaveBeenNthCalledWith(2, { groupId: 1, tabIds: [100] });
      expect(browser.state.tabs.map((t) => t.groupId)).toEqual([1, -1, 1]);
      expect(data.projects).toEqual([expect.objectContaining({ id: 'p1', groupId: 1 })]);
      expect(browser.api.tabs.create).toHaveBeenCalledWith({
        url: `${BASE}?id=p1`,
        windowId: 4,
        index: 3,
        active: true,
      });
    },
  );

  it('reuses a grouped tab’s existing project', async () => {
    const source = tab(1, 7, 0);
    const browser = makeBrowser({
      groups: [group(7)],
      tabs: [source, tab(2, 7, 1, { url: `${BASE}?id=a` })],
    });
    const { service, data } = makeService(browser, { stored: [stored('a', 7)] });

    expect(await service.openProjectForTab(source)).toMatchObject({
      createdProject: false,
      createdTab: false,
      tabId: 2,
    });
    expect(browser.api.tabs.group).not.toHaveBeenCalled();
    expect(data.projects).toHaveLength(1);
  });

  it('does not create a project when grouping fails', async () => {
    const browser = makeBrowser({ tabs: [tab(1, -1, 0)] });
    browser.api.tabs.group.mockRejectedValueOnce(new Error('cannot group tab'));
    const { service, data } = makeService(browser);

    await expect(service.openProjectForTab(browser.state.tabs[0])).rejects.toThrow(
      'cannot group tab',
    );
    expect(data.projects).toEqual([]);
    expect(browser.api.tabs.create).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { id: -1 }])(
    'does nothing when no usable tab is available: %s',
    async (source) => {
      const browser = makeBrowser();
      const { service } = makeService(browser);
      expect(await service.openProjectForTab(source)).toBeNull();
      expect(browser.api.tabs.group).not.toHaveBeenCalled();
      expect(browser.api.tabs.create).not.toHaveBeenCalled();
    },
  );
});

describe('rebinding through the service', () => {
  it('notifies onRebound only when a sync changed bindings', async () => {
    const browser = makeBrowser({
      groups: [group(3, 'Other'), group(55, 'Renamed')],
      tabs: [tab(9, 55, 0, { url: `${BASE}?id=a` })],
    });
    const onRebound = vi.fn();
    const { service } = makeService(browser, { stored: [stored('a', 3)], onRebound });

    await service.handleStartup();
    await vi.waitFor(() => expect(onRebound).toHaveBeenCalledTimes(1));
    await service.sync();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRebound).toHaveBeenCalledTimes(1);
  });

  it('rebinds after browser startup via the project tab', async () => {
    const browser = makeBrowser({
      groups: [group(3, 'Other'), group(55, 'Renamed')],
      tabs: [tab(9, 55, 0, { url: `${BASE}?id=a` })],
    });
    const { service, data } = makeService(browser, {
      stored: [stored('a', 3)],
    });

    await service.handleStartup();

    expect(data.projects[0]).toMatchObject({ groupId: 55, title: 'Renamed' });
  });

  it.each(['', 'Duplicate'])(
    'keeps anchorless %j groups bound across worker reloads',
    async (title) => {
      const browser = makeBrowser({ groups: [group(7, title), group(8, title)] });
      const projects = [stored('a', 7, title), stored('b', 8, title)];
      // The helper defaults to a trusted session when recreating the service.
      const { service, data } = makeService(browser, { stored: projects });
      await service.sync();
      const result = await service.openProjectForTab(tab(1, 7, 0));
      expect(result).toMatchObject({ project: { id: 'a' }, createdProject: false });
      expect(data.projects).toHaveLength(2);
      expect(data.projects.map((project) => project.groupId)).toEqual([7, 8]);
    },
  );

  it('rejects reused ids only on browser startup and keeps them invalid after another reload', async () => {
    const browser = makeBrowser({ groups: [group(7, ''), group(8, '')] });
    const { service, data } = makeService(browser, { stored: [stored('a', 7, '')] });
    await service.handleStartup();
    expect(data.projects[0].groupId).toBeNull();
    const reloaded = makeService(browser, { stored: data.projects });
    await reloaded.service.sync();
    expect(reloaded.data.projects[0].groupId).toBeNull();
  });

  it('uses an unambiguous title and color after browser startup', async () => {
    const browser = makeBrowser({ groups: [group(7, 'Other'), group(55, 'Work')] });
    const { service, data } = makeService(browser, { stored: [stored('a', 7)] });
    await service.handleStartup();
    expect(data.projects[0].groupId).toBe(55);
  });

  it('makes concurrent sync calls wait for startup invalidation to persist', async () => {
    const browser = makeBrowser({ groups: [group(7, '')] });
    let saved = [stored('a', 7, '')];
    let finishReset;
    const projectStore = createProjectStore({
      get: async (key) => ({ [key]: saved }),
      set: async (items) => {
        await new Promise((resolve) => {
          finishReset = resolve;
        });
        saved = items.projects;
      },
      queue: (_key, fn) => fn(),
      key: 'projects',
    });
    const service = createProjectService({
      ...browser.api,
      getURL: () => BASE,
      projectStore,
    });
    const startup = service.handleStartup();
    const concurrent = service.sync();
    await vi.waitFor(() => expect(finishReset).toBeTypeOf('function'));
    expect(browser.api.tabGroups.query).not.toHaveBeenCalled();
    finishReset();
    await Promise.all([startup, concurrent]);
    expect(saved[0].groupId).toBeNull();
  });

  it('keeps syncing after the startup reset write fails', async () => {
    const browser = makeBrowser({ groups: [group(7, '')] });
    let fail = true;
    let saved = [stored('a', 7, '')];
    const projectStore = createProjectStore({
      get: async (key) => ({ [key]: saved }),
      set: async (items) => {
        if (fail) {
          fail = false;
          throw new Error('quota');
        }
        saved = items.projects;
      },
      queue: (_key, fn) => fn(),
      key: 'projects',
    });
    const service = createProjectService({
      ...browser.api,
      getURL: () => BASE,
      projectStore,
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    await expect(service.handleStartup()).rejects.toThrow('quota');
    await expect(service.sync()).resolves.toMatchObject({ projects: expect.any(Array) });
    expect(saved[0].groupId).toBeNull();
  });

  it('offers project recovery from the menu instead of creating another project', async () => {
    const browser = makeBrowser({ groups: [group(7), group(8)], tabs: [tab(1, 7, 0)] });
    const { service, data } = makeService(browser, { stored: [stored('a', null)] });
    expect(await service.openProjectForTab(browser.state.tabs[0])).toMatchObject({
      needsAttachment: true,
    });
    expect(browser.api.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://ext/options.html#projects',
      active: true,
    });
    expect(data.projects).toHaveLength(1);
    expect(browser.api.tabs.group).not.toHaveBeenCalled();
  });

  it('reuses the recovery options tab on repeated requests', async () => {
    const browser = makeBrowser({ groups: [group(7), group(8)], tabs: [tab(1, 7, 0)] });
    const { service } = makeService(browser, { stored: [stored('a', null)] });
    expect(await service.openProjectForTab(browser.state.tabs[0])).toMatchObject({
      needsAttachment: true,
      tabId: 100,
    });
    expect(await service.openProjectForTab(browser.state.tabs[0])).toMatchObject({
      needsAttachment: true,
      tabId: 100,
    });
    expect(browser.api.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.api.tabs.update).toHaveBeenCalledWith(100, { active: true });
  });

  it('creates projects for unrelated groups and ungrouped tabs despite closed projects', async () => {
    const browser = makeBrowser({
      groups: [group(7, 'Other')],
      tabs: [tab(1, 7, 0), tab(2, -1, 1)],
    });
    const { service } = makeService(browser, { stored: [stored('a', null)] });
    expect(await service.openProjectForTab(browser.state.tabs[0])).toMatchObject({
      createdProject: true,
    });
    expect(await service.openProjectForTab(browser.state.tabs[1])).toMatchObject({
      createdProject: true,
    });
  });

  it('invalidates IDs before the first snapshot and retries after a worker restart', async () => {
    const browser = makeBrowser({ groups: [group(7, '')] });
    let trusted = false;
    const bindingSession = {
      isTrusted: vi.fn(async () => trusted),
      markTrusted: vi.fn(async () => {
        trusted = true;
      }),
    };
    let saved = [stored('a', 7, '')];
    let fail = true;
    const projectStore = createProjectStore({
      key: 'projects',
      get: async (key) => ({ [key]: saved }),
      set: async (items) => {
        if (fail) {
          fail = false;
          throw new Error('quota');
        }
        saved = items.projects;
      },
      queue: (_key, fn) => fn(),
    });
    const makeWorker = () =>
      createProjectService({ ...browser.api, getURL: () => BASE, projectStore, bindingSession });
    const first = makeWorker();
    await expect(Promise.all([first.sync(), first.sync()])).rejects.toThrow('quota');
    expect(trusted).toBe(false);
    expect(browser.api.tabGroups.query).not.toHaveBeenCalled();
    await makeWorker().sync();
    expect(saved[0].groupId).toBeNull();
    expect(trusted).toBe(true);
    expect(bindingSession.markTrusted).toHaveBeenCalledTimes(1);
  });

  it.each(['isTrusted', 'markTrusted'])('retries after %s fails', async (failingMethod) => {
    const browser = makeBrowser({ groups: [group(7, '')] });
    const bindingSession = {
      isTrusted: vi.fn(async () => false),
      markTrusted: vi.fn(async () => {}),
    };
    bindingSession[failingMethod].mockRejectedValueOnce(new Error('session failure'));
    const { service, data } = makeService(browser, {
      stored: [stored('a', 7, '')],
      bindingSession,
    });
    await expect(service.sync()).rejects.toThrow('session failure');
    expect(browser.api.tabGroups.query).not.toHaveBeenCalled();
    await service.sync();
    expect(data.projects[0].groupId).toBeNull();
    expect(bindingSession.markTrusted).toHaveBeenCalled();
  });

  it('preserves anchorless bindings in an already trusted session', async () => {
    const browser = makeBrowser({ groups: [group(7, ''), group(8, '')] });
    const bindingSession = { isTrusted: vi.fn(async () => true), markTrusted: vi.fn() };
    const { service, data } = makeService(browser, {
      stored: [stored('a', 7, '')],
      bindingSession,
    });
    await service.sync();
    expect(data.projects[0].groupId).toBe(7);
    expect(bindingSession.markTrusted).not.toHaveBeenCalled();
  });

  it('unbinds removed groups', async () => {
    const { service, data } = makeService(makeBrowser(), { stored: [stored('a', 3)] });
    await service.handleGroupRemoved(3);
    expect(data.projects[0].groupId).toBeNull();
  });
});

describe('concurrent opens', () => {
  it('creates a single project tab for two quick opens of one group', async () => {
    const browser = makeBrowser({ groups: [group(7)], tabs: [tab(1, 7, 0)] });
    const { service, data } = makeService(browser);
    const [first, second] = await Promise.all([
      service.openProjectForGroup(7),
      service.openProjectForGroup(7),
    ]);
    expect(browser.api.tabs.create).toHaveBeenCalledTimes(1);
    expect(data.projects).toHaveLength(1);
    expect(first.createdTab).toBe(true);
    expect(second).toMatchObject({ createdTab: false, tabId: first.tabId });
  });

  it('serializes openProject and attachProjectToGroup with the same group open', async () => {
    const browser = makeBrowser({ groups: [group(7)], tabs: [tab(1, 7, 0)] });
    const { service } = makeService(browser, { stored: [stored('a', null)] });
    await Promise.all([
      service.attachProjectToGroup('a', 7),
      service.openProject('a'),
      service.openProject('a'),
    ]);
    expect(browser.api.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('keeps serving opens after one fails', async () => {
    const browser = makeBrowser({ groups: [group(7)], tabs: [tab(1, 7, 0)] });
    const { service } = makeService(browser);
    const results = await Promise.allSettled([
      service.openProjectForGroup(99),
      service.openProjectForGroup(7),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });
});

describe('attachProjectToGroup', () => {
  it('recovers an unbound identity and saved tree and moves its standalone page into the group', async () => {
    const browser = makeBrowser({
      groups: [group(7, '')],
      tabs: [tab(1, 7, 0), tab(2, -1, 1, { url: `${BASE}?id=a` })],
    });
    const tree = { status: 'done', topics: [{ title: 'Saved topic' }] };
    const { service, data } = makeService(browser, {
      stored: [{ ...stored('a', null, 'Saved'), topic_tree: tree }],
    });
    expect(await service.attachProjectToGroup('a', 7)).toMatchObject({
      project: { id: 'a', groupId: 7, title: 'Saved' },
      tabId: 2,
      createdTab: false,
    });
    expect(data.projects).toHaveLength(1);
    expect(data['projects:tree:a']).toEqual(tree);
    expect(browser.api.tabs.group).toHaveBeenCalledWith({ groupId: 7, tabIds: [2] });
    expect(browser.api.tabs.create).not.toHaveBeenCalled();
    expect(await service.getProjectView('a')).toMatchObject({
      project: { id: 'a', topic_tree: tree },
      isOpen: true,
    });
  });

  it('creates an anchor tab for an attached project', async () => {
    const browser = makeBrowser({ groups: [group(7, 'New')], tabs: [tab(1, 7, 0)] });
    const { service } = makeService(browser, { stored: [stored('a', null, 'Saved')] });
    expect(await service.attachProjectToGroup('a', 7)).toMatchObject({
      project: { id: 'a', groupId: 7, title: 'New' },
      createdTab: true,
    });
    expect(browser.api.tabs.create).toHaveBeenCalledWith(
      expect.objectContaining({ url: `${BASE}?id=a` }),
    );
  });

  it('rolls back the binding when the anchor tab cannot be created', async () => {
    const browser = makeBrowser({ groups: [group(7, '')], tabs: [tab(1, 7, 0)] });
    browser.api.tabs.create.mockRejectedValueOnce(new Error('window gone'));
    const { service, data } = makeService(browser, { stored: [stored('a', null, 'Saved')] });
    await expect(service.attachProjectToGroup('a', 7)).rejects.toThrow('window gone');
    expect(data.projects[0]).toMatchObject({ id: 'a', groupId: null, title: 'Saved' });
  });

  it('removes a newly created tab and rolls back when grouping fails', async () => {
    const browser = makeBrowser({ groups: [group(7, 'New')], tabs: [tab(1, 7, 0)] });
    browser.api.tabs.group.mockRejectedValueOnce(new Error('group failed'));
    const { service, data } = makeService(browser, { stored: [stored('a', null, 'Saved')] });
    await expect(service.attachProjectToGroup('a', 7)).rejects.toThrow('group failed');
    expect(browser.api.tabs.remove).toHaveBeenCalledWith(100);
    expect(browser.state.tabs.map((t) => t.id)).toEqual([1]);
    expect(data.projects[0]).toMatchObject({ groupId: null, title: 'Saved' });
  });

  it.each([false, true])(
    'keeps attachment when focus fails (existing tab: %s)',
    async (existing) => {
      const browser = makeBrowser({
        groups: [group(7, 'New')],
        tabs: [tab(1, 7, 0), ...(existing ? [tab(2, -1, 1, { url: BASE + '?id=a' })] : [])],
      });
      browser.api.windows.update.mockRejectedValueOnce(new Error('focus failed'));
      const { service, data } = makeService(browser, { stored: [stored('a', null, 'Saved')] });
      expect(await service.attachProjectToGroup('a', 7)).toMatchObject({ createdTab: !existing });
      expect(data.projects[0].groupId).toBe(7);
    },
  );

  it('preserves concurrent metadata updates when rolling back an attachment', async () => {
    const browser = makeBrowser({ groups: [group(7, 'New')], tabs: [tab(1, 7, 0)] });
    const { service, data } = makeService(browser, { stored: [stored('a', null, 'Saved')] });
    browser.api.tabs.create.mockImplementationOnce(async () => {
      data.projects[0] = { ...data.projects[0], title: 'Concurrent', color: 'red' };
      throw new Error('window gone');
    });
    await expect(service.attachProjectToGroup('a', 7)).rejects.toThrow('window gone');
    expect(data.projects[0]).toMatchObject({ groupId: null, title: 'Concurrent', color: 'red' });
  });

  it('refuses to steal a project or overwrite another project binding', async () => {
    const browser = makeBrowser({ groups: [group(7, ''), group(8, '')] });
    const { service, data } = makeService(browser, {
      stored: [stored('a', 7, ''), stored('b', null, '')],
    });
    await expect(service.attachProjectToGroup('a', 8)).rejects.toThrow('already attached');
    await expect(service.attachProjectToGroup('b', 7)).rejects.toThrow('already has a project');
    await expect(service.attachProjectToGroup('missing', 8)).rejects.toThrow('project not found');
    await expect(service.attachProjectToGroup('b', 99)).rejects.toThrow('tab group not found');
    expect(data.projects.map((project) => project.groupId)).toEqual([7, null]);
    expect(browser.api.tabs.create).not.toHaveBeenCalled();
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
      handleStartup: vi.fn(async () => {}),
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
    expect(projectService.handleStartup).not.toHaveBeenCalled();
  });

  it('invalidates cached ids on browser startup', async () => {
    const { chromeRuntime, projectService } = install();
    chromeRuntime.onStartup.listeners[0]();
    expect(projectService.handleStartup).toHaveBeenCalledTimes(1);
    expect(projectService.sync).not.toHaveBeenCalled();
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

  it('flashes failure feedback when the menu or command action fails', async () => {
    const event = () => {
      const listeners = [];
      return { listeners, addListener: (fn) => listeners.push(fn) };
    };
    const notifyActionFailure = vi.fn();
    const logger = { warn: vi.fn() };
    const projectService = {
      sync: vi.fn(async () => {}),
      openProjectForTab: vi
        .fn()
        .mockResolvedValueOnce({ tabId: 9 })
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('boom')),
    };
    const chromeContextMenus = { onClicked: event() };
    const chromeCommands = { onCommand: event() };
    installProjectRuntime({
      projectService,
      chromeContextMenus,
      chromeCommands,
      chromeTabs: {
        query: vi.fn(async () => {
          throw new Error('no tabs');
        }),
      },
      logger,
      notifyActionFailure,
    });
    const click = () =>
      chromeContextMenus.onClicked.listeners[0]({ menuItemId: OPEN_GROUP_PROJECT_MENU_ID }, {});

    click();
    await new Promise((r) => setTimeout(r));
    expect(notifyActionFailure).not.toHaveBeenCalled();

    click();
    await vi.waitFor(() => expect(notifyActionFailure).toHaveBeenCalledTimes(1));

    click();
    await vi.waitFor(() => expect(notifyActionFailure).toHaveBeenCalledTimes(2));
    expect(logger.warn).toHaveBeenCalledWith('open group project failed:', expect.any(Error));

    chromeCommands.onCommand.listeners[0](OPEN_GROUP_PROJECT_COMMAND);
    await vi.waitFor(() => expect(notifyActionFailure).toHaveBeenCalledTimes(3));
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

describe('project excerpts menu', () => {
  const event = () => {
    const listeners = [];
    return { listeners, addListener: vi.fn((fn) => listeners.push(fn)) };
  };

  it('adds a selection menu limited to web pages', async () => {
    const menus = { removeAll: vi.fn(async () => {}), create: vi.fn((_props, cb) => cb()) };
    await createProjectMenus(menus);
    expect(menus.create).toHaveBeenCalledWith(
      {
        id: OPEN_EXCERPT_MENU_ID,
        title: 'Open excerpt in project',
        contexts: ['selection'],
        documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
      },
      expect.any(Function),
    );
  });

  it('routes the selection menu to the excerpt service', async () => {
    const onClicked = event();
    const excerptService = { openExcerptFromSelection: vi.fn(async () => null) };
    installProjectRuntime({
      projectService: { sync: vi.fn(async () => {}), openProjectForTab: vi.fn() },
      excerptService,
      chromeContextMenus: { onClicked },
      logger: { warn: vi.fn() },
    });
    const tab = { id: 1 };
    onClicked.listeners[0](
      { menuItemId: OPEN_EXCERPT_MENU_ID, selectionText: 'Hi', frameId: 0 },
      tab,
    );
    expect(excerptService.openExcerptFromSelection).toHaveBeenCalledWith(tab, {
      selectionText: 'Hi',
      frameId: 0,
    });
  });

  it('flashes failure feedback for an empty selection or a failed excerpt', async () => {
    const onClicked = event();
    const notifyActionFailure = vi.fn();
    const excerptService = {
      openExcerptFromSelection: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('this page cannot hold an excerpt')),
    };
    installProjectRuntime({
      projectService: { sync: vi.fn(async () => {}) },
      excerptService,
      chromeContextMenus: { onClicked },
      logger: { warn: vi.fn() },
      notifyActionFailure,
    });
    const click = () => onClicked.listeners[0]({ menuItemId: OPEN_EXCERPT_MENU_ID }, { id: 1 });
    click();
    await vi.waitFor(() => expect(notifyActionFailure).toHaveBeenCalledTimes(1));
    click();
    await vi.waitFor(() => expect(notifyActionFailure).toHaveBeenCalledTimes(2));
  });
});
