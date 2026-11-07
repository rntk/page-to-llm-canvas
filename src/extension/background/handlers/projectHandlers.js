import { MSG } from '../../../shared/runtime/messages.js';
import { isProjectId, isTabGroupId } from '../../../core/projects/projects.js';

const validateGroupId = (msg) => (isTabGroupId(msg.groupId) ? null : 'invalid groupId');
const validateProjectId = (msg) => (isProjectId(msg.projectId) ? null : 'invalid projectId');
const validateProjectTab = (msg) =>
  validateProjectId(msg) ||
  (Number.isInteger(msg.tabId) && msg.tabId >= 0 ? null : 'invalid tabId');
const validateProjectExcerpt = (msg) =>
  validateProjectId(msg) || (isProjectId(msg.excerptId) ? null : 'invalid excerptId');

/**
 * Project (tab group) handlers. All of them drive or expose tab state, so only
 * trusted extension pages (Options, the project page) may call them.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../projects.js').createProjectService>} deps.projectService
 * @param {ReturnType<typeof import('../projectPageChat.js').createProjectPageChatService>} deps.pageChatService
 * @param {ReturnType<typeof import('../projectExcerpts.js').createProjectExcerptService>} [deps.excerptService]
 *   Without it projects have no excerpts.
 */
export function createProjectHandlers({ projectService, pageChatService, excerptService }) {
  const entry = (validate, run) => ({
    requiresExtensionPage: true,
    validate,
    async handle(msg) {
      return { ok: true, ...(await run(msg)) };
    },
  });
  const requireExcerpts = () => {
    if (!excerptService) throw new Error('excerpts are not available');
    return excerptService;
  };

  return {
    [MSG.listProjectsOverview]: entry(
      () => null,
      () => projectService.listProjectsOverview(),
    ),
    [MSG.createProjectFromGroup]: entry(validateGroupId, (msg) =>
      projectService.createProjectFromGroup(msg.groupId),
    ),
    [MSG.openProjectForGroup]: entry(validateGroupId, (msg) =>
      projectService.openProjectForGroup(msg.groupId),
    ),
    [MSG.openProject]: entry(validateProjectId, (msg) => projectService.openProject(msg.projectId)),
    [MSG.focusProjectGroup]: entry(validateProjectId, (msg) =>
      projectService.focusGroup(msg.projectId),
    ),
    [MSG.deleteProject]: entry(validateProjectId, (msg) =>
      (excerptService || projectService).deleteProject(msg.projectId),
    ),
    // The view carries the project's excerpts and, once, the excerpt the page
    // should unfold (one just opened from a page's context menu).
    [MSG.getProjectView]: entry(validateProjectId, async (msg) => {
      const view = await projectService.getProjectView(msg.projectId);
      if (!excerptService) return { ...view, excerpts: [], focusExcerptId: null };
      return { ...view, ...(await excerptService.takeProjectExcerpts(msg.projectId)) };
    }),
    [MSG.getProjectPageChat]: entry(validateProjectTab, async (msg) => ({
      source: await pageChatService.getPageChat(msg.projectId, msg.tabId),
    })),
    [MSG.captureProjectPageText]: entry(validateProjectTab, (msg) =>
      pageChatService.capturePageText(msg.projectId, msg.tabId),
    ),
    [MSG.deleteProjectExcerpt]: entry(validateProjectExcerpt, (msg) =>
      requireExcerpts().deleteExcerpt(msg.projectId, msg.excerptId),
    ),
    [MSG.readProjectExcerptPage]: entry(validateProjectExcerpt, (msg) =>
      requireExcerpts().readExcerptPage(msg.projectId, msg.excerptId),
    ),
  };
}
