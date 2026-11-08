// Pure excerpt domain plus its chrome.storage.local repository. An excerpt is a
// passage the user selected on a page and opened on a project canvas. It is
// anchored to its page by URL (tab ids do not survive a restart) and owns a
// chat of its own under `excerptChatKey(id)`.

import { getLocal, setLocal, queuedUpdate } from '../storage/primitives.js';
import { PROJECT_EXCERPTS_STORAGE_KEY, canonicalPageUrl } from '../storage/keys.js';
import { isProjectId } from './projects.js';

// Bounds one excerpt; a longer selection is cut rather than refused.
export const MAX_EXCERPT_CHARS = 20_000;

/**
 * @typedef {object} ProjectExcerpt
 * @property {string} id
 * @property {string} projectId
 * @property {string} url The page URL without its fragment.
 * @property {string} title Page title when the excerpt was taken.
 * @property {string} text
 * @property {boolean} truncated True when the selection was longer than MAX_EXCERPT_CHARS.
 * @property {number} createdAt Epoch milliseconds.
 */

/**
 * Trims a selection and collapses runs of blank lines and trailing spaces.
 * @param {*} text
 * @returns {string}
 */
export function normalizeExcerptText(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {*} value Raw stored excerpt.
 * @returns {ProjectExcerpt|null}
 */
export function normalizeExcerpt(value) {
  if (!value || typeof value !== 'object') return null;
  if (!isProjectId(value.id) || value.id.includes(':') || !isProjectId(value.projectId)) {
    return null;
  }
  const url = canonicalPageUrl(value.url);
  const text = typeof value.text === 'string' ? value.text : '';
  if (!url || !text) return null;
  return {
    id: value.id,
    projectId: value.projectId,
    url,
    title: typeof value.title === 'string' ? value.title : '',
    text,
    truncated: !!value.truncated,
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : 0,
  };
}

/**
 * @param {{projectId: string, url: string, title?: string, text: string}} input
 * @param {{id: string, now: number}} identity
 * @returns {ProjectExcerpt|null} Null when the text or URL is unusable.
 */
export function createExcerpt({ projectId, url, title, text }, { id, now }) {
  const normalized = normalizeExcerptText(text);
  return normalizeExcerpt({
    id,
    projectId,
    url,
    title,
    text: normalized.slice(0, MAX_EXCERPT_CHARS),
    truncated: normalized.length > MAX_EXCERPT_CHARS,
    createdAt: now,
  });
}

/**
 * @param {*} stored Raw stored document.
 * @returns {{excerpts: ProjectExcerpt[], focus: {projectId: string, excerptId: string}|null}}
 */
export function normalizeStoredExcerpts(stored) {
  const seen = new Set();
  const excerpts = [];
  for (const value of Array.isArray(stored?.excerpts) ? stored.excerpts : []) {
    const excerpt = normalizeExcerpt(value);
    if (!excerpt || seen.has(excerpt.id)) continue;
    seen.add(excerpt.id);
    excerpts.push(excerpt);
  }
  const focus =
    isProjectId(stored?.focus?.projectId) && seen.has(stored?.focus?.excerptId)
      ? { projectId: stored.focus.projectId, excerptId: stored.focus.excerptId }
      : null;
  return { excerpts, focus };
}

/**
 * Serialized repository over the single PROJECT_EXCERPTS_STORAGE_KEY document.
 * Besides the excerpts it holds one pending focus request: the excerpt the
 * project page should unfold next (the one just opened from a page).
 *
 * @param {object} [deps] Storage adapter; defaults to chrome.storage.local.
 * @param {function(string): Promise<object>} [deps.get]
 * @param {function(object): Promise<void>} [deps.set]
 * @param {function(string, Function): Promise<*>} [deps.queue]
 * @param {string} [deps.key]
 */
export function createExcerptStore({
  get = getLocal,
  set = setLocal,
  queue = queuedUpdate,
  key = PROJECT_EXCERPTS_STORAGE_KEY,
} = {}) {
  async function read() {
    const items = await get(key);
    return normalizeStoredExcerpts(items?.[key]);
  }

  /**
   * @param {function({excerpts: ProjectExcerpt[], focus: object|null}): (object|null)} mutate
   *   Returns the next document, or null to skip the write.
   */
  function update(mutate) {
    return queue(key, async () => {
      const current = await read();
      const next = mutate(current);
      if (!next || next === current) return current;
      await set({ [key]: next });
      return next;
    });
  }

  return {
    key,
    read,
    update,

    /**
     * @param {string} projectId
     * @returns {Promise<ProjectExcerpt[]>} Oldest first.
     */
    async listForProject(projectId) {
      return (await read()).excerpts.filter((excerpt) => excerpt.projectId === projectId);
    },

    /**
     * @param {ProjectExcerpt} excerpt
     * @param {{focus?: boolean}} [options] Request that the project page unfolds it.
     */
    add(excerpt, { focus = false } = {}) {
      return update((current) => ({
        excerpts: [...current.excerpts.filter((item) => item.id !== excerpt.id), excerpt],
        focus: focus ? { projectId: excerpt.projectId, excerptId: excerpt.id } : current.focus,
      }));
    },

    /**
     * Removes the matching excerpts.
     * @param {function(ProjectExcerpt): boolean} predicate
     * @returns {Promise<ProjectExcerpt[]>} The removed excerpts.
     */
    async removeWhere(predicate) {
      let removed = [];
      await update((current) => {
        removed = current.excerpts.filter(predicate);
        if (!removed.length) return null;
        const excerpts = current.excerpts.filter((excerpt) => !predicate(excerpt));
        const focus =
          current.focus && excerpts.some((excerpt) => excerpt.id === current.focus.excerptId)
            ? current.focus
            : null;
        return { excerpts, focus };
      });
      return removed;
    },

    /**
     * The project's pending focus request, without consuming it.
     * @param {string} projectId
     * @returns {Promise<string|null>} The excerpt id to unfold, if any.
     */
    async peekFocus(projectId) {
      const { focus } = await read();
      return focus?.projectId === projectId ? focus.excerptId : null;
    },

    /**
     * Clears the project's pending focus request if it still points at the
     * excerpt (a newer request is left alone). Idempotent.
     * @param {string} projectId
     * @param {string} excerptId
     */
    async acknowledgeFocus(projectId, excerptId) {
      await update((current) =>
        current.focus?.projectId === projectId && current.focus.excerptId === excerptId
          ? { ...current, focus: null }
          : null,
      );
    },
  };
}
