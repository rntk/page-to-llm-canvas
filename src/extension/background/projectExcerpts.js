import { createExcerpt } from '../../core/projects/excerpts.js';
import { excerptChatKey, projectChatKey } from '../../core/storage/keys.js';

/**
 * Project excerpts: passages selected on a page and opened on its project
 * canvas, each with a chat of its own.
 *
 * @param {object} deps
 * @param {{groupForTab: Function, createProjectFromGroup: Function, openProjectForGroup: Function, deleteProject: Function}} deps.projectService
 * @param {{readPageText: function(string, string): Promise<object>}} deps.pageChatService
 * @param {ReturnType<typeof import('../../core/projects/excerpts.js').createExcerptStore>} deps.excerptStore
 * @param {function(string): Promise<*>} deps.deleteChats Deletes every chat under a chat key.
 * @param {function(number, object, object=): Promise<*>} [deps.sendTabMessage] `chrome.tabs.sendMessage`.
 * @param {function(): number} [deps.now]
 * @param {function(): string} [deps.createId]
 * @param {{info: Function, warn: Function}} [deps.logger]
 */
export function createProjectExcerptService({
  projectService,
  pageChatService,
  excerptStore,
  deleteChats,
  sendTabMessage,
  now = () => Date.now(),
  createId = () => crypto.randomUUID(),
  logger = console,
}) {
  async function requireExcerpt(projectId, excerptId) {
    const excerpt = (await excerptStore.listForProject(projectId)).find((e) => e.id === excerptId);
    if (!excerpt) throw new Error('excerpt not found');
    return excerpt;
  }

  // The menu's `selectionText` collapses line breaks, so prefer the page's own
  // selection. The content script runs in the top frame only.
  async function readSelection(tab, { selectionText, frameId }) {
    if (sendTabMessage && (frameId === undefined || frameId === 0)) {
      try {
        const response = await sendTabMessage(
          tab.id,
          { action: 'captureSelectionText' },
          { frameId: 0 },
        );
        if (
          response?.status === 'ok' &&
          typeof response.text === 'string' &&
          response.text.trim()
        ) {
          return response.text;
        }
      } catch {
        /* Fall back to the menu's copy of the selection. */
      }
    }
    return typeof selectionText === 'string' ? selectionText : '';
  }

  async function removeExcerpts(predicate) {
    const removed = await excerptStore.removeWhere(predicate);
    for (const excerpt of removed) {
      await deleteChats(excerptChatKey(excerpt.id)).catch((err) =>
        logger.warn?.('excerpt chat cleanup failed:', err),
      );
    }
    return removed;
  }

  return {
    /**
     * Saves the selection as an excerpt of the tab's project (grouping the tab
     * and creating the project when needed) and opens the project page, which
     * unfolds the new excerpt's chat.
     * @param {object|undefined} tab
     * @param {{selectionText?: string, frameId?: number}} [selection]
     * @returns {Promise<{excerpt: object, projectId: string}|null>}
     */
    async openExcerptFromSelection(tab, selection = {}) {
      const text = await (tab ? readSelection(tab, selection) : '');
      const groupId = text.trim() ? await projectService.groupForTab(tab) : null;
      if (groupId === null) {
        logger.info?.('open excerpt: no selection or tab');
        return null;
      }
      const { project } = await projectService.createProjectFromGroup(groupId);
      const excerpt = createExcerpt(
        { projectId: project.id, url: tab.url || tab.pendingUrl || '', title: tab.title, text },
        { id: createId(), now: now() },
      );
      if (!excerpt) throw new Error('this page cannot hold an excerpt');
      await excerptStore.add(excerpt, { focus: true });
      await projectService.openProjectForGroup(groupId);
      return { excerpt, projectId: project.id };
    },

    /**
     * The project's excerpts, plus the excerpt its page should unfold (handed
     * out once).
     * @param {string} projectId
     * @returns {Promise<{excerpts: object[], focusExcerptId: string|null}>}
     */
    async takeProjectExcerpts(projectId) {
      const focusExcerptId = await excerptStore.takeFocus(projectId);
      return { excerpts: await excerptStore.listForProject(projectId), focusExcerptId };
    },

    /**
     * @param {string} projectId
     * @param {string} excerptId
     * @returns {Promise<{deleted: boolean}>}
     */
    async deleteExcerpt(projectId, excerptId) {
      const removed = await removeExcerpts(
        (excerpt) => excerpt.projectId === projectId && excerpt.id === excerptId,
      );
      return { deleted: removed.length > 0 };
    },

    /**
     * Forgets a project along with its excerpts, their chats and the project chat.
     * @param {string} projectId
     * @returns {Promise<{deleted: boolean}>}
     */
    async deleteProject(projectId) {
      const result = await projectService.deleteProject(projectId);
      await removeExcerpts((excerpt) => excerpt.projectId === projectId);
      await deleteChats(projectChatKey(projectId)).catch((err) =>
        logger.warn?.('project chat cleanup failed:', err),
      );
      return result;
    },

    /**
     * The full text of the page an excerpt was taken from.
     * @param {string} projectId
     * @param {string} excerptId
     * @returns {Promise<{sentences: string[], truncated: boolean, source: string}>}
     */
    async readExcerptPage(projectId, excerptId) {
      const excerpt = await requireExcerpt(projectId, excerptId);
      return pageChatService.readPageText(projectId, excerpt.url);
    },
  };
}
