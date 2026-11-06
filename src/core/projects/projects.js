// Pure project domain: a project is a persistent identity for a browser tab
// group. `groupId` is runtime-only (it changes after a browser restart), so it
// is only a cache; the project page tab (`project.html?id=<projectId>`) living
// inside the group is the durable anchor used to rebind it.

export const PROJECT_PAGE_PATH = 'project.html';

/** `chrome.tabGroups.TAB_GROUP_ID_NONE`, inlined so this module stays browser-free. */
export const TAB_GROUP_ID_NONE = -1;

/**
 * @typedef {object} Project
 * @property {string} id Persistent project id.
 * @property {string} title Last known group title.
 * @property {string} color Last known group color.
 * @property {number|null} groupId Cached live group id, or null when no live group is bound.
 * @property {number} createdAt Epoch milliseconds.
 * @property {number} updatedAt Epoch milliseconds.
 */

/**
 * @param {*} value
 * @returns {boolean} True for a usable live tab group id.
 */
export function isTabGroupId(value) {
  return Number.isInteger(value) && value !== TAB_GROUP_ID_NONE && value >= 0;
}

/**
 * @param {*} value
 * @returns {boolean}
 */
export function isProjectId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Normalizes one stored project, dropping entries that cannot be addressed.
 * @param {*} value
 * @returns {Project|null}
 */
export function normalizeProject(value) {
  if (!value || typeof value !== 'object' || !isProjectId(value.id)) return null;
  const createdAt = Number.isFinite(value.createdAt) ? value.createdAt : 0;
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : '',
    color: typeof value.color === 'string' ? value.color : '',
    groupId: isTabGroupId(value.groupId) ? value.groupId : null,
    createdAt,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt,
  };
}

/**
 * @param {{id: number, title?: string, color?: string}} group Live tab group.
 * @param {{id: string, now: number}} identity
 * @returns {Project}
 */
export function createProjectFromGroup(group, { id, now }) {
  return {
    id,
    title: typeof group.title === 'string' ? group.title : '',
    color: typeof group.color === 'string' ? group.color : '',
    groupId: group.id,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @param {string} pageBaseUrl Absolute URL of project.html (`runtime.getURL(PROJECT_PAGE_PATH)`).
 * @param {string} projectId
 * @returns {string}
 */
export function buildProjectPageUrl(pageBaseUrl, projectId) {
  return `${pageBaseUrl}?id=${encodeURIComponent(projectId)}`;
}

/**
 * Returns the project id when `url` is our project page, otherwise null.
 * @param {string|undefined} url Tab URL.
 * @param {string} pageBaseUrl Absolute URL of project.html.
 * @returns {string|null}
 */
export function parseProjectIdFromUrl(url, pageBaseUrl) {
  if (typeof url !== 'string' || !url || typeof pageBaseUrl !== 'string') return null;
  let parsed;
  let base;
  try {
    parsed = new URL(url);
    base = new URL(pageBaseUrl);
  } catch {
    return null;
  }
  // `origin` is opaque ("null") for chrome-extension: and moz-extension: URLs.
  if (
    parsed.protocol !== base.protocol ||
    parsed.host !== base.host ||
    parsed.pathname !== base.pathname
  ) {
    return null;
  }
  const id = parsed.searchParams.get('id');
  return isProjectId(id) ? id : null;
}

/**
 * Tabs that are project pages, keyed by project id. A tab's `pendingUrl` counts
 * so a just-created project tab anchors before it commits its navigation.
 * @param {object[]} tabs
 * @param {string} pageBaseUrl
 * @returns {Map<string, object[]>}
 */
export function indexProjectTabs(tabs, pageBaseUrl) {
  const index = new Map();
  for (const tab of tabs || []) {
    const id =
      parseProjectIdFromUrl(tab?.url, pageBaseUrl) ??
      parseProjectIdFromUrl(tab?.pendingUrl, pageBaseUrl);
    if (!id) continue;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(tab);
  }
  return index;
}

const sameGroupFields = (project, group) =>
  project.title === (group.title || '') && project.color === (group.color || '');

/**
 * Rebinds each project's cached `groupId` against the live browser state and
 * syncs title/color from its bound group. Binding priority:
 *   1. a project page tab inside a live group (the anchor);
 *   2. the cached groupId, when `trustCached` and the group is still live and
 *      unclaimed (false right after a restart, when ids may have been reused);
 *   3. an unambiguous non-empty title + color match among unclaimed groups.
 * Anything else becomes unbound (`groupId: null`). A group binds at most one project.
 *
 * @param {Project[]} projects
 * @param {object[]} groups Live `tabGroups.query({})` result.
 * @param {object[]} tabs Live `tabs.query({})` result.
 * @param {{pageBaseUrl: string, now: number, trustCached?: boolean}} options
 * @returns {{projects: Project[], changed: boolean}}
 */
export function rebindProjects(projects, groups, tabs, { pageBaseUrl, now, trustCached = true }) {
  const liveGroups = new Map(
    (groups || []).filter((g) => isTabGroupId(g?.id)).map((g) => [g.id, g]),
  );
  const claimed = new Map(); // groupId -> projectId
  const bindings = new Map(); // projectId -> groupId
  const knownIds = new Set(projects.map((p) => p.id));

  // 1. Anchors: the first live-grouped project tab wins for each project.
  for (const [projectId, projectTabs] of indexProjectTabs(tabs, pageBaseUrl)) {
    if (!knownIds.has(projectId)) continue;
    const anchor = projectTabs.find((t) => liveGroups.has(t.groupId) && !claimed.has(t.groupId));
    if (!anchor) continue;
    claimed.set(anchor.groupId, projectId);
    bindings.set(projectId, anchor.groupId);
  }

  // 2. Cached ids.
  if (trustCached) {
    for (const project of projects) {
      if (bindings.has(project.id) || !liveGroups.has(project.groupId)) continue;
      if (claimed.has(project.groupId)) continue;
      claimed.set(project.groupId, project.id);
      bindings.set(project.id, project.groupId);
    }
  }

  // 3. Unambiguous title + color fallback.
  const unbound = projects.filter((p) => !bindings.has(p.id) && p.title);
  for (const project of unbound) {
    const rivals = unbound.filter((p) => p.title === project.title && p.color === project.color);
    if (rivals.length !== 1) continue;
    const candidates = [...liveGroups.values()].filter(
      (g) => g.title && !claimed.has(g.id) && sameGroupFields(project, g),
    );
    if (candidates.length !== 1) continue;
    claimed.set(candidates[0].id, project.id);
    bindings.set(project.id, candidates[0].id);
  }

  let changed = false;
  const next = projects.map((project) => {
    const groupId = bindings.has(project.id) ? bindings.get(project.id) : null;
    const group = groupId === null ? null : liveGroups.get(groupId);
    // An untitled group keeps the project's remembered title.
    const title = group && group.title ? group.title : project.title;
    const color = group && group.color ? group.color : project.color;
    if (groupId === project.groupId && title === project.title && color === project.color) {
      return project;
    }
    changed = true;
    return { ...project, groupId, title, color, updatedAt: now };
  });
  return { projects: next, changed };
}

/**
 * Marks the project bound to a removed group as unbound.
 * @param {Project[]} projects
 * @param {number} groupId
 * @param {number} now
 * @returns {{projects: Project[], changed: boolean}}
 */
export function unbindGroup(projects, groupId, now) {
  let changed = false;
  const next = projects.map((project) => {
    if (project.groupId !== groupId) return project;
    changed = true;
    return { ...project, groupId: null, updatedAt: now };
  });
  return { projects: next, changed };
}
