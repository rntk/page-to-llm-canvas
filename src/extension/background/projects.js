// Worker-side project service: binds persistent projects to live tab groups and
// opens/focuses each project's page tab inside its group. Browser APIs are
// injected (promise-returning `chrome.tabs`/`tabGroups`/`windows` shapes) so the
// service is testable without a browser.

import {
  PROJECT_PAGE_PATH,
  buildProjectPageUrl,
  createProjectFromGroup,
  indexProjectTabs,
  isTabGroupId,
  parseProjectIdFromUrl,
  rebindProjects,
  unbindGroup,
} from '../../core/projects/projects.js';

/**
 * @param {object} tab
 * @returns {{id: number, title: string, url: string, favIconUrl: string, active: boolean, index: number, status: string}}
 */
function toTabView(tab) {
  return {
    id: tab.id,
    title: tab.title || '',
    url: tab.url || tab.pendingUrl || '',
    favIconUrl: tab.favIconUrl || '',
    active: !!tab.active,
    index: tab.index,
    status: tab.status || '',
  };
}

const byIndex = (a, b) => a.index - b.index;

/**
 * @param {object} deps
 * @param {{query: Function, create: Function, update: Function, group: Function}} deps.tabs
 * @param {{query: Function, get: Function}} deps.tabGroups
 * @param {{update: Function}} deps.windows
 * @param {function(string): string} deps.getURL `chrome.runtime.getURL`.
 * @param {ReturnType<typeof import('../../core/projects/projectStorage.js').createProjectStore>} deps.projectStore
 * @param {{isTrusted: function(): Promise<boolean>, markTrusted: function(): Promise<void>}} [deps.bindingSession]
 *   Session-scoped flag: cached groupIds are only trusted once this browser
 *   session has rebound them (storage.session is cleared on restart).
 * @param {function(): number} [deps.now]
 * @param {function(): string} [deps.createId]
 * @param {{info: Function, warn: Function}} [deps.logger]
 */
export function createProjectService({
  tabs,
  tabGroups,
  windows,
  getURL,
  projectStore,
  bindingSession = { isTrusted: async () => true, markTrusted: async () => {} },
  now = () => Date.now(),
  createId = () => crypto.randomUUID(),
  logger = console,
}) {
  const pageBaseUrl = () => getURL(PROJECT_PAGE_PATH);
  const pageUrl = (projectId) => buildProjectPageUrl(pageBaseUrl(), projectId);

  async function snapshot() {
    const [groups, allTabs] = await Promise.all([tabGroups.query({}), tabs.query({})]);
    return { groups: groups || [], tabs: allTabs || [] };
  }

  /**
   * Rebinds stored projects against live state and returns both.
   * @returns {Promise<{projects: object[], groups: object[], tabs: object[]}>}
   */
  async function sync() {
    const live = await snapshot();
    let trustCached = true;
    try {
      trustCached = await bindingSession.isTrusted();
    } catch {
      /* Without session storage the cache is the best information available. */
    }
    const projects = await projectStore.update((current) => {
      const result = rebindProjects(current, live.groups, live.tabs, {
        pageBaseUrl: pageBaseUrl(),
        now: now(),
        trustCached,
      });
      return result.changed ? result.projects : null;
    });
    if (!trustCached) await bindingSession.markTrusted().catch(() => {});
    return { projects, ...live };
  }

  async function requireProject(projectId, projects) {
    const project = projects.find((p) => p.id === projectId);
    if (!project) throw new Error('project not found');
    return project;
  }

  async function focusTab(tab) {
    await tabs.update(tab.id, { active: true });
    if (Number.isInteger(tab.windowId)) await windows.update(tab.windowId, { focused: true });
  }

  /**
   * Finds an existing project tab, preferring one already inside `groupId`.
   * @param {string} projectId
   * @param {object[]} allTabs
   * @param {number|null} groupId
   */
  function findProjectTab(projectId, allTabs, groupId) {
    const candidates = indexProjectTabs(allTabs, pageBaseUrl()).get(projectId) || [];
    return candidates.find((t) => t.groupId === groupId) || candidates[0] || null;
  }

  /**
   * Focuses the project's page tab in `group`, creating it after the group's
   * last tab (and moving a stray one into the group) when needed.
   * @param {object} project
   * @param {object} group Live tab group.
   * @param {object[]} allTabs
   */
  async function ensureProjectTabInGroup(project, group, allTabs) {
    const existing = findProjectTab(project.id, allTabs, group.id);
    if (existing) {
      if (existing.groupId !== group.id) {
        await tabs.group({ groupId: group.id, tabIds: [existing.id] });
      }
      await focusTab(existing);
      return { tabId: existing.id, createdTab: false };
    }
    const groupTabs = allTabs.filter((t) => t.groupId === group.id);
    const lastIndex = groupTabs.reduce((max, t) => Math.max(max, t.index), -1);
    const created = await tabs.create({
      url: pageUrl(project.id),
      windowId: group.windowId,
      ...(lastIndex >= 0 ? { index: lastIndex + 1 } : {}),
      active: true,
    });
    await tabs.group({ groupId: group.id, tabIds: [created.id] });
    if (Number.isInteger(group.windowId)) await windows.update(group.windowId, { focused: true });
    return { tabId: created.id, createdTab: true };
  }

  /**
   * Finds or creates the project bound to a live group.
   * @param {number|null} groupId
   */
  async function bindOrCreate(groupId) {
    const state = await sync();
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) throw new Error('tab group not found');
    const bound = state.projects.find((p) => p.groupId === groupId);
    if (bound) return { project: bound, createdProject: false, group, state };
    const project = createProjectFromGroup(group, { id: createId(), now: now() });
    await projectStore.update((current) => {
      // Another event may have bound the group meanwhile; keep that binding.
      if (current.some((p) => p.groupId === groupId)) return null;
      return [...current, project];
    });
    const stored = (await projectStore.list()).find((p) => p.groupId === groupId) || project;
    return { project: stored, createdProject: stored.id === project.id, group, state };
  }

  const service = {
    sync,

    /** @param {string|undefined} url @returns {boolean} */
    isProjectPageUrl: (url) => parseProjectIdFromUrl(url, pageBaseUrl()) !== null,

    /**
     * @param {number} groupId
     * @returns {Promise<{project: object, createdProject: boolean, tabId: number, createdTab: boolean}>}
     */
    async openProjectForGroup(groupId) {
      const { project, createdProject, group, state } = await bindOrCreate(groupId);
      const tab = await ensureProjectTabInGroup(project, group, state.tabs);
      return { project, createdProject, ...tab };
    },

    /**
     * @param {number} groupId
     * @returns {Promise<{project: object, createdProject: boolean}>}
     */
    async createProjectFromGroup(groupId) {
      const { project, createdProject } = await bindOrCreate(groupId);
      return { project, createdProject };
    },

    /**
     * Opens the project page. A live group gets (or focuses) its in-group tab;
     * a closed project just opens its page in a standalone tab.
     * @param {string} projectId
     * @returns {Promise<{project: object, isOpen: boolean, tabId: number, createdTab: boolean}>}
     */
    async openProject(projectId) {
      const state = await sync();
      const project = await requireProject(projectId, state.projects);
      const group = state.groups.find((g) => g.id === project.groupId);
      if (group) {
        return {
          project,
          isOpen: true,
          ...(await ensureProjectTabInGroup(project, group, state.tabs)),
        };
      }
      const existing = findProjectTab(project.id, state.tabs, null);
      if (existing) {
        await focusTab(existing);
        return { project, isOpen: false, tabId: existing.id, createdTab: false };
      }
      const created = await tabs.create({ url: pageUrl(project.id), active: true });
      return { project, isOpen: false, tabId: created.id, createdTab: true };
    },

    /**
     * Activates a tab in the project's live group (its project tab when present).
     * @param {string} projectId
     * @returns {Promise<{isOpen: boolean, tabId: number|null}>}
     */
    async focusGroup(projectId) {
      const state = await sync();
      const project = await requireProject(projectId, state.projects);
      if (!isTabGroupId(project.groupId)) return { isOpen: false, tabId: null };
      const groupTabs = state.tabs.filter((t) => t.groupId === project.groupId).sort(byIndex);
      const target =
        findProjectTab(project.id, groupTabs, project.groupId) ||
        groupTabs.find((t) => t.active) ||
        groupTabs[0];
      if (!target) return { isOpen: true, tabId: null };
      await focusTab(target);
      return { isOpen: true, tabId: target.id };
    },

    /**
     * Forgets a project. Never closes or ungroups user tabs.
     * @param {string} projectId
     * @returns {Promise<{deleted: boolean}>}
     */
    async deleteProject(projectId) {
      let deleted = false;
      await projectStore.update((current) => {
        const next = current.filter((p) => p.id !== projectId);
        deleted = next.length !== current.length;
        return deleted ? next : null;
      });
      return { deleted };
    },

    /**
     * Tab counts exclude project page tabs, so they match getProjectView.
     * @returns {Promise<{projects: object[], ungroupedGroups: object[]}>}
     */
    async listProjectsOverview() {
      const state = await sync();
      const projectTabIds = new Set(
        [...indexProjectTabs(state.tabs, pageBaseUrl()).values()].flat().map((t) => t.id),
      );
      const countTabs = (groupId) =>
        state.tabs.filter((t) => t.groupId === groupId && !projectTabIds.has(t.id)).length;
      const boundGroupIds = new Set(state.projects.map((p) => p.groupId).filter(isTabGroupId));
      return {
        projects: state.projects.map((project) => {
          const isOpen = isTabGroupId(project.groupId);
          return { ...project, isOpen, tabCount: isOpen ? countTabs(project.groupId) : 0 };
        }),
        ungroupedGroups: state.groups
          .filter((g) => !boundGroupIds.has(g.id))
          .map((g) => ({
            groupId: g.id,
            title: g.title || '',
            color: g.color || '',
            windowId: g.windowId,
            tabCount: countTabs(g.id),
          })),
      };
    },

    /**
     * The canvas model: the project's group tabs, minus its own page tab.
     * @param {string} projectId
     * @returns {Promise<{project: object, isOpen: boolean, tabs: object[]}>}
     */
    async getProjectView(projectId) {
      const state = await sync();
      const project = await requireProject(projectId, state.projects);
      const isOpen = isTabGroupId(project.groupId);
      if (!isOpen) return { project, isOpen, tabs: [] };
      const ownTabIds = new Set(
        (indexProjectTabs(state.tabs, pageBaseUrl()).get(project.id) || []).map((t) => t.id),
      );
      const groupTabs = state.tabs
        .filter((t) => t.groupId === project.groupId && !ownTabIds.has(t.id))
        .sort(byIndex)
        .map(toTabView);
      return { project, isOpen, tabs: groupTabs };
    },

    /**
     * tabGroups.onRemoved: the group is gone, so its project becomes unbound.
     * @param {number|null} groupId
     */
    async handleGroupRemoved(groupId) {
      await projectStore.update((current) => {
        const result = unbindGroup(current, groupId, now());
        return result.changed ? result.projects : null;
      });
    },

    /**
     * Opens the project for a tab, creating a group around ungrouped tabs first.
     * @param {object|undefined} tab
     */
    async openProjectForTab(tab) {
      if (!tab || !Number.isInteger(tab.id) || tab.id < 0) {
        logger.info?.('open group project: no tab available');
        return null;
      }
      const groupId = isTabGroupId(tab.groupId)
        ? tab.groupId
        : await tabs.group({ tabIds: [tab.id] });
      return service.openProjectForGroup(groupId);
    },
  };
  return service;
}

/**
 * Coalesces bursts of tab/group events into sequential rebinding passes.
 * @param {function(): Promise<*>} run
 * @param {{warn: Function}} [logger]
 * @returns {function(): Promise<void>}
 */
export function createCoalescedRunner(run, logger = console) {
  let pending = null;
  let rerun = false;
  return function schedule() {
    if (pending) {
      rerun = true;
      return pending;
    }
    pending = (async () => {
      do {
        rerun = false;
        try {
          await run();
        } catch (err) {
          logger.warn?.('project rebinding failed:', err);
        }
      } while (rerun);
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export const OPEN_GROUP_PROJECT_MENU_ID = 'open-group-project';
export const OPEN_GROUP_PROJECT_COMMAND = 'open-group-project';

/**
 * Creates the context menu entries. `tab` (tab strip) context exists only in
 * Firefox's `menus` API; Chrome rejects the unknown enum value, so fall back.
 * @param {object} contextMenus `chrome.contextMenus`.
 */
export function createProjectMenus(contextMenus) {
  const base = { id: OPEN_GROUP_PROJECT_MENU_ID, title: 'Open group project' };
  const create = (contexts) =>
    new Promise((resolve, reject) => {
      contextMenus.create({ ...base, contexts }, () => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error) reject(new Error(error.message));
        else resolve();
      });
    });
  const types = contextMenus.ContextType ? Object.values(contextMenus.ContextType) : [];
  const supportsTab = types.includes('tab');
  return Promise.resolve(contextMenus.removeAll()).then(async () => {
    if (supportsTab) {
      try {
        await create(['page', 'action', 'tab']);
        return;
      } catch {
        /* Fall through to the portable contexts. */
      }
    }
    try {
      await create(['page', 'action']);
    } catch {
      /* A duplicate id after a racing removeAll is harmless. */
    }
  });
}

/**
 * Registers project listeners. Must run synchronously during worker module
 * evaluation, like installBackgroundRuntime. Every namespace is optional so
 * browsers (or tests) without tab groups simply skip the feature.
 *
 * @param {object} deps
 * @param {ReturnType<typeof createProjectService>} deps.projectService
 * @param {object} [deps.chromeRuntime]
 * @param {object} [deps.chromeTabs]
 * @param {object} [deps.chromeTabGroups]
 * @param {object} [deps.chromeContextMenus]
 * @param {object} [deps.chromeCommands]
 * @param {{info: Function, warn: Function}} [deps.logger]
 */
export function installProjectRuntime({
  projectService,
  chromeRuntime,
  chromeTabs,
  chromeTabGroups,
  chromeContextMenus,
  chromeCommands,
  logger = console,
}) {
  const scheduleRebind = createCoalescedRunner(() => projectService.sync(), logger);
  const listen = (event, listener) => {
    if (event?.addListener) event.addListener(listener);
  };
  const openForTab = (tab) => {
    projectService.openProjectForTab(tab).catch((err) => {
      logger.warn?.('open group project failed:', err);
    });
  };
  const installMenus = () => {
    if (!chromeContextMenus?.create) return;
    createProjectMenus(chromeContextMenus).catch((err) => {
      logger.warn?.('project menu setup failed:', err);
    });
  };

  listen(chromeRuntime?.onInstalled, () => {
    installMenus();
    void scheduleRebind();
  });
  listen(chromeRuntime?.onStartup, () => {
    installMenus();
    void scheduleRebind();
  });

  listen(chromeContextMenus?.onClicked, (info, tab) => {
    if (info?.menuItemId === OPEN_GROUP_PROJECT_MENU_ID) openForTab(tab);
  });

  listen(chromeCommands?.onCommand, (command, tab) => {
    if (command !== OPEN_GROUP_PROJECT_COMMAND) return;
    if (tab) {
      openForTab(tab);
      return;
    }
    Promise.resolve(chromeTabs?.query?.({ active: true, currentWindow: true }))
      .then((found) => openForTab(found?.[0]))
      .catch((err) => logger.warn?.('open group project failed:', err));
  });

  // Ordinary navigations are ignored; only a project page load or a group
  // membership change can move an anchor.
  listen(chromeTabs?.onUpdated, (_tabId, changeInfo) => {
    if (!changeInfo) return;
    if ('groupId' in changeInfo || projectService.isProjectPageUrl(changeInfo.url)) {
      void scheduleRebind();
    }
  });
  listen(chromeTabs?.onAttached, () => void scheduleRebind());
  listen(chromeTabGroups?.onCreated, () => void scheduleRebind());
  listen(chromeTabGroups?.onUpdated, () => void scheduleRebind());
  listen(chromeTabGroups?.onRemoved, (group) => {
    if (!isTabGroupId(group?.id)) return;
    projectService
      .handleGroupRemoved(group.id)
      .catch((err) => logger.warn?.('project unbind failed:', err));
  });

  return { scheduleRebind };
}
