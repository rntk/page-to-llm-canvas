// Extension-page client for the worker's project service (see
// src/extension/background/projects.js). Every call rejects with an Error when
// the worker answers `{ok: false}` or the runtime transport fails.

import { MSG } from '../shared/runtime/messages.js';
import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';
import { subscribeLocalChanges } from '../shared/runtime/localStore.js';
import {
  projectTopicTreeStorageKey,
  PROJECT_EXCERPTS_STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
} from '../core/storage/keys.js';
import { INDEX_KEY } from '../core/storage/recordIndex.js';

/** @typedef {ReturnType<typeof createProjectsApi>} ProjectsApi */

/**
 * @param {{send: function(object): Promise<*>}} messenger
 */
export function createProjectsApi(messenger = browserRuntimeMessenger) {
  async function request(message) {
    const response = await messenger.send(message);
    if (!response?.ok) throw new Error(response?.error || 'Project request failed');
    const { ok: _ok, ...result } = response;
    return result;
  }

  return Object.freeze({
    /** @returns {Promise<{projects: object[], ungroupedGroups: object[]}>} */
    listProjectsOverview: () => request({ type: MSG.listProjectsOverview }),
    /** @param {number} groupId @returns {Promise<{project: object, createdProject: boolean}>} */
    createProjectFromGroup: (groupId) => request({ type: MSG.createProjectFromGroup, groupId }),
    /**
     * @param {number} groupId
     * @returns {Promise<{project: object, createdProject: boolean, tabId: number, createdTab: boolean}>}
     */
    openProjectForGroup: (groupId) => request({ type: MSG.openProjectForGroup, groupId }),
    /**
     * @param {string} projectId
     * @returns {Promise<{project: object, isOpen: boolean, tabId: number, createdTab: boolean}>}
     */
    openProject: (projectId) => request({ type: MSG.openProject, projectId }),
    /** @param {string} projectId @returns {Promise<{isOpen: boolean, tabId: number|null}>} */
    focusGroup: (projectId) => request({ type: MSG.focusProjectGroup, projectId }),
    /** @param {string} projectId @returns {Promise<{deleted: boolean}>} */
    deleteProject: (projectId) => request({ type: MSG.deleteProject, projectId }),
    /** @param {string} projectId @returns {Promise<{project: object, isOpen: boolean, tabs: object[]}>} */
    getProjectView: (projectId) => request({ type: MSG.getProjectView, projectId }),
    /** @param {string} projectId @param {object} [options] */
    buildProjectTopicTree: (projectId, { fresh = false } = {}) =>
      request({ type: MSG.buildProjectTopicTree, projectId, fresh }),
    /** @param {string} projectId */
    stopProjectTopicTree: (projectId) => request({ type: MSG.stopProjectTopicTree, projectId }),
    /**
     * Where a tab's per-page chat lives: its saved record, or a URL page key.
     * @param {string} projectId
     * @param {number} tabId
     * @returns {Promise<{source: object}>}
     */
    getPageChat: (projectId, tabId) => request({ type: MSG.getProjectPageChat, projectId, tabId }),
    /**
     * Reads a tab's live text as chat sentences.
     * @param {string} projectId
     * @param {number} tabId
     * @returns {Promise<{sentences: string[], truncated: boolean}>}
     */
    capturePageText: (projectId, tabId) =>
      request({ type: MSG.captureProjectPageText, projectId, tabId }),
    /**
     * @param {string} projectId
     * @param {string} excerptId
     * @returns {Promise<{deleted: boolean}>}
     */
    deleteExcerpt: (projectId, excerptId) =>
      request({ type: MSG.deleteProjectExcerpt, projectId, excerptId }),
    /**
     * Tells the background the project page handled the excerpt focus request.
     * @param {string} projectId
     * @param {string} excerptId
     * @returns {Promise<{acknowledged: boolean}>}
     */
    acknowledgeExcerptFocus: (projectId, excerptId) =>
      request({ type: MSG.acknowledgeProjectExcerptFocus, projectId, excerptId }),
    /**
     * Reads the full text of the page an excerpt was taken from.
     * @param {string} projectId
     * @param {string} excerptId
     * @returns {Promise<{sentences: string[], truncated: boolean, source: string}>}
     */
    readExcerptPage: (projectId, excerptId) =>
      request({ type: MSG.readProjectExcerptPage, projectId, excerptId }),
  });
}

export const browserProjectsApi = createProjectsApi();

export const {
  listProjectsOverview,
  createProjectFromGroup,
  openProjectForGroup,
  openProject,
  focusGroup,
  deleteProject,
  getProjectView,
  buildProjectTopicTree,
  stopProjectTopicTree,
  getPageChat,
  capturePageText,
  deleteExcerpt,
  acknowledgeExcerptFocus,
  readExcerptPage,
} = browserProjectsApi;

const TAB_EVENTS = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached'];
const GROUP_EVENTS = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved'];

/**
 * Listens to live tab/tab group events and calls `onChange()` for those relevant to
 * `scope` (every event when unscoped or before the view loads). Missing namespaces are
 * skipped.
 *
 * @param {function(): void} onChange
 * @param {{tabs?: object, tabGroups?: object}} apis
 * @param {{projectId: string, getView: function(): object|null}} [scope]
 * @returns {function(): void} Unsubscribe.
 */
function subscribeTabEvents(onChange, { tabs, tabGroups }, scope) {
  const groupChanged = (_name, [group], view) => {
    if (group?.id === view.project?.groupId) onChange();
  };
  const tabChanged = (name, args, view) => {
    const groupId = view.project?.groupId;
    const tab = name === 'onCreated' ? args[0] : name === 'onUpdated' ? args[2] : null;
    const id = name === 'onCreated' ? tab?.id : args[0];
    const belongs = (value) => groupId != null && value?.groupId === groupId;
    if (view.tabs?.some((item) => item.id === id) || belongs(tab)) return onChange();
    // Attach events omit group identity; resolve arrivals across windows.
    if (name === 'onAttached' && tabs?.get) {
      Promise.resolve(tabs.get(id))
        .then((live) => {
          if (belongs(live)) onChange();
        })
        .catch(() => {});
    }
  };
  const attached = [];
  const attach = (namespace, names, handle) => {
    for (const name of names) {
      const event = namespace?.[name];
      if (!event?.addListener) continue;
      const listener = (...args) => {
        const view = scope?.getView();
        if (!view) return onChange();
        handle(name, args, view);
      };
      event.addListener(listener);
      attached.push([event, listener]);
    }
  };
  attach(tabs, TAB_EVENTS, tabChanged);
  attach(tabGroups, GROUP_EVENTS, groupChanged);
  return () => {
    for (const [event, listener] of attached) event.removeListener?.(listener);
  };
}

const differs = (change, select) =>
  change && JSON.stringify(select(change.oldValue)) !== JSON.stringify(select(change.newValue));

/**
 * Listens to stored projects, excerpts, the index and (when scoped) the project's topic
 * tree. When scoped, project/excerpt writes only notify if the project's slice changed.
 *
 * @param {function(): void} onChange
 * @param {{projectId: string, getView: function(): object|null}} [scope]
 * @returns {function(): void} Unsubscribe.
 */
function subscribeStoreChanges(onChange, scope) {
  const treeKey = scope && projectTopicTreeStorageKey(scope.projectId);
  const keys = [PROJECTS_STORAGE_KEY, PROJECT_EXCERPTS_STORAGE_KEY, INDEX_KEY];
  if (treeKey) keys.push(treeKey);
  return subscribeLocalChanges(keys, (changes) => {
    if (!scope?.getView()) return onChange();
    if (changes[treeKey] || changes[INDEX_KEY]) return onChange();
    const { projectId } = scope;
    const projectChanged = differs(changes[PROJECTS_STORAGE_KEY], (items) =>
      items?.find?.((item) => item.id === projectId),
    );
    const excerptsChanged = differs(changes[PROJECT_EXCERPTS_STORAGE_KEY], (doc) => ({
      excerpts: doc?.excerpts?.filter((item) => item.projectId === projectId),
      focus: doc?.focus?.projectId === projectId ? doc.focus : null,
    }));
    if (projectChanged || excerptsChanged) onChange();
  });
}

/**
 * Calls `onChange()` (no arguments) whenever stored projects or excerpts, or live tabs/tab
 * groups change, so a page can refetch its view. Callers should debounce; tab events can
 * arrive in bursts.
 *
 * @param {function(): void} onChange
 * @param {object} [options]
 * @param {{projectId: string, getView: function(): object|null}} [options.scope] Current
 *   project view; omit for overview subscriptions.
 * @param {{tabs?: object, tabGroups?: object}} [options.apis] Browser namespaces; defaults
 *   to `chrome.tabs` and `chrome.tabGroups`.
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeProjectChanges(
  onChange,
  {
    scope,
    apis = { tabs: globalThis.chrome?.tabs, tabGroups: globalThis.chrome?.tabGroups },
  } = {},
) {
  const unsubscribeTabs = subscribeTabEvents(onChange, apis, scope);
  const unsubscribeStore = subscribeStoreChanges(onChange, scope);
  return () => {
    unsubscribeStore();
    unsubscribeTabs();
  };
}
