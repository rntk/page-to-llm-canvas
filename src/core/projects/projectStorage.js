// Project metadata and separate topic snapshots share one mutation queue.

import { getLocal, setLocal, queuedUpdate } from '../storage/primitives.js';
import { PROJECTS_STORAGE_KEY, projectTopicTreeStorageKey } from '../storage/keys.js';
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
  const treeKey = (id) =>
    key === PROJECTS_STORAGE_KEY
      ? projectTopicTreeStorageKey(id)
      : key + ':tree:' + encodeURIComponent(id);
  const metadata = ({ topic_tree: _tree, ...project }) => project;
  async function readMetadata() {
    const items = await get(key);
    return normalizeStoredProjects(items?.[key]);
  }
  async function hydrate(project) {
    if (project.topic_tree) return project;
    const items = await get(treeKey(project.id));
    const tree = items?.[treeKey(project.id)];
    return tree ? normalizeProject({ ...project, topic_tree: tree }) : project;
  }
  async function list({ includeTrees = true } = {}) {
    const projects = await readMetadata();
    return includeTrees ? Promise.all(projects.map(hydrate)) : projects.map(metadata);
  }
  async function persist(current, next, raw, includeTrees = true) {
    const writes = {};
    const previous = new Map(current.map((project) => [project.id, project]));
    const legacy = new Map(
      raw.filter((project) => project.topic_tree).map((p) => [p.id, p.topic_tree]),
    );
    for (const project of next) {
      if (
        legacy.has(project.id) ||
        (includeTrees && project.topic_tree !== previous.get(project.id)?.topic_tree)
      ) {
        writes[treeKey(project.id)] =
          (includeTrees ? project.topic_tree : legacy.get(project.id)) || null;
      }
    }
    const ids = new Set(next.map((project) => project.id));
    for (const project of current) {
      if (!ids.has(project.id)) writes[treeKey(project.id)] = null;
    }
    const stripped = next.map(metadata);
    if (JSON.stringify(raw) !== JSON.stringify(stripped)) writes[key] = stripped;
    if (Object.keys(writes).length) await set(writes);
  }
  return {
    key,
    list,
    async get(projectId) {
      const project = (await readMetadata()).find((item) => item.id === projectId);
      return project ? hydrate(project) : null;
    },
    update(mutate, { includeTrees = true } = {}) {
      return queue(key, async () => {
        const raw = await readMetadata();
        const current = includeTrees ? await Promise.all(raw.map(hydrate)) : raw.map(metadata);
        const next = mutate(current);
        if (!next || next === current) return current;
        await persist(current, next, raw, includeTrees);
        return next;
      });
    },
    // Shares the collection queue so deletion and ownership checks serialize.
    updateProject(projectId, mutate) {
      return queue(key, async () => {
        const raw = await readMetadata();
        const index = raw.findIndex((project) => project.id === projectId);
        if (index < 0) return null;
        const project = await hydrate(raw[index]);
        const updated = mutate(project);
        if (!updated || updated === project) return project;
        const current = [...raw];
        current[index] = project;
        const next = [...current];
        next[index] = updated;
        await persist(current, next, raw);
        return updated;
      });
    },
  };
}
