import { MSG } from '../../../shared/runtime/messages.js';
import { isProjectId, isTabGroupId } from '../../../core/projects/projects.js';

const validateGroupId = (msg) => (isTabGroupId(msg.groupId) ? null : 'invalid groupId');
const validateProjectId = (msg) => (isProjectId(msg.projectId) ? null : 'invalid projectId');
const validateProjectTab = (msg) =>
  validateProjectId(msg) ||
  (Number.isInteger(msg.tabId) && msg.tabId >= 0 ? null : 'invalid tabId');

/**
 * Project (tab group) handlers. All of them drive or expose tab state, so only
 * trusted extension pages (Options, the project page) may call them.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../projects.js').createProjectService>} deps.projectService
 * @param {ReturnType<typeof import('../projectPageChat.js').createProjectPageChatService>} deps.pageChatService
 */
export function createProjectHandlers({ projectService, pageChatService }) {
  const entry = (validate, run) => ({
    requiresExtensionPage: true,
    validate,
    async handle(msg) {
      return { ok: true, ...(await run(msg)) };
    },
  });

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
      projectService.deleteProject(msg.projectId),
    ),
    [MSG.getProjectView]: entry(validateProjectId, (msg) =>
      projectService.getProjectView(msg.projectId),
    ),
    [MSG.getProjectPageChat]: entry(validateProjectTab, async (msg) => ({
      source: await pageChatService.getPageChat(msg.projectId, msg.tabId),
    })),
    [MSG.captureProjectPageText]: entry(validateProjectTab, (msg) =>
      pageChatService.capturePageText(msg.projectId, msg.tabId),
    ),
  };
}
