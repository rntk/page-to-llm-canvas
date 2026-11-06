// chrome.storage.local repository for projects. Every write is a serialized
// read-modify-write over the single PROJECTS_STORAGE_KEY document, so event
// storms (session restore, group drags) cannot lose updates.

import { getLocal, setLocal, queuedUpdate } from '../storage/primitives.js';
import { PROJECTS_STORAGE_KEY } from '../storage/keys.js';
import { normalizeProject } from './projects.js';

/**
 * @param {*} stored Raw stored value.
 * @returns {import('./projects.js').Project[]}
 */
export function normalizeStoredProjects(stored) {
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  const projects = [];
  for (const value of stored) {
    const project = normalizeProject(value);
    if (!project || seen.has(project.id)) continue;
    seen.add(project.id);
    projects.push(project);
  }
  return projects;
}

/**
 * @param {object} [deps] Storage adapter; defaults to chrome.storage.local.
 * @param {function(string): Promise<object>} [deps.get]
 * @param {function(object): Promise<void>} [deps.set]
 * @param {function(string, Function): Promise<*>} [deps.queue] Per-key mutation queue.
 * @param {string} [deps.key]
 */
export function createProjectStore({
  get = getLocal,
  set = setLocal,
  queue = queuedUpdate,
  key = PROJECTS_STORAGE_KEY,
} = {}) {
  async function list() {
    const items = await get(key);
    return normalizeStoredProjects(items?.[key]);
  }

  return {
    key,
    list,

    /** @param {string} projectId */
    async get(projectId) {
      return (await list()).find((project) => project.id === projectId) || null;
    },

    /**
     * Applies `mutate` to the current list and persists its result. Returning
     * null (or the same array) from `mutate` skips the write.
     * @param {function(import('./projects.js').Project[]): (import('./projects.js').Project[]|null)} mutate
     * @returns {Promise<import('./projects.js').Project[]>} The list after the update.
     */
    update(mutate) {
      return queue(key, async () => {
        const current = await list();
        const next = mutate(current);
        if (!next || next === current) return current;
        await set({ [key]: next });
        return next;
      });
    },
  };
}
