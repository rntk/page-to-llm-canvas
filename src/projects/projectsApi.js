// Extension-page client for the worker's project service (see
// src/extension/background/projects.js). Every call rejects with an Error when
// the worker answers `{ok: false}` or the runtime transport fails.

import { MSG } from '../shared/runtime/messages.js';
import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';
import { subscribeLocalChanges } from '../shared/runtime/localStore.js';
import { PROJECT_EXCERPTS_STORAGE_KEY, PROJECTS_STORAGE_KEY } from '../core/storage/keys.js';

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
  getPageChat,
  capturePageText,
  deleteExcerpt,
  readExcerptPage,
} = browserProjectsApi;

const TAB_EVENTS = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved', 'onAttached', 'onDetached'];
const GROUP_EVENTS = ['onCreated', 'onRemoved', 'onUpdated', 'onMoved'];

/**
 * Calls `onChange()` (no arguments) whenever stored projects or excerpts, or live tabs/tab
 * groups change, so a page can refetch its view. Missing browser namespaces are
 * skipped. Callers should debounce; tab events can arrive in bursts.
 *
 * @param {function(): void} onChange
 * @param {{tabs?: object, tabGroups?: object}} [apis]
 * @returns {function(): void} Unsubscribe.
 */
export function subscribeProjectChanges(
  onChange,
  apis = { tabs: globalThis.chrome?.tabs, tabGroups: globalThis.chrome?.tabGroups },
) {
  const listener = () => onChange();
  const attached = [];
  const attach = (namespace, names) => {
    for (const name of names) {
      const event = namespace?.[name];
      if (!event?.addListener) continue;
      event.addListener(listener);
      attached.push(event);
    }
  };
  attach(apis.tabs, TAB_EVENTS);
  attach(apis.tabGroups, GROUP_EVENTS);
  const unsubscribeStore = subscribeLocalChanges(
    [PROJECTS_STORAGE_KEY, PROJECT_EXCERPTS_STORAGE_KEY],
    listener,
  );
  return () => {
    unsubscribeStore();
    for (const event of attached) event.removeListener?.(listener);
  };
}
