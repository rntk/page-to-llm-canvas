/**
 * Bind canvas and merge operations to the selected project once at the app boundary.
 * @param {import('./projectsApi.js').ProjectsApi} api
 * @param {string|null} projectId
 */
export function bindProjectApi(api, projectId) {
  return {
    loadSource: (tabId) => api.getPageChat(projectId, tabId),
    capture: (tabId) => api.capturePageText(projectId, tabId),
    readPage: (excerptId) => api.readExcerptPage(projectId, excerptId),
    deleteExcerpt: (excerptId) => api.deleteExcerpt(projectId, excerptId),
    acknowledgeFocus: (excerptId) => api.acknowledgeExcerptFocus(projectId, excerptId),
    buildTopics: (options) => api.buildProjectTopicTree(projectId, options),
    stopTopics: () => api.stopProjectTopicTree(projectId),
  };
}
