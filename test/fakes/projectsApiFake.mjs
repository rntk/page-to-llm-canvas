import { vi } from 'vitest';

/**
 * Builds a complete projects API fake (see `createProjectsApi`). Every method is
 * a `vi.fn` resolving to an inert success; pass overrides for the calls a test
 * cares about.
 *
 * @param {Partial<import('../../src/projects/projectsApi.js').ProjectsApi>} [overrides]
 * @returns {import('../../src/projects/projectsApi.js').ProjectsApi}
 */
export function createFakeProjectsApi(overrides = {}) {
  return {
    listProjectsOverview: vi.fn(async () => ({ projects: [], ungroupedGroups: [] })),
    createProjectFromGroup: vi.fn(async () => ({ project: null, createdProject: false })),
    openProjectForGroup: vi.fn(async () => ({})),
    openProject: vi.fn(async () => ({})),
    focusGroup: vi.fn(async () => ({ isOpen: false, tabId: null })),
    deleteProject: vi.fn(async () => ({ deleted: true })),
    getProjectView: vi.fn(() => new Promise(() => {})),
    buildProjectTopicTree: vi.fn(async () => ({})),
    stopProjectTopicTree: vi.fn(async () => ({})),
    getPageChat: vi.fn(async () => ({ source: null })),
    capturePageText: vi.fn(async () => ({ sentences: [], truncated: false })),
    deleteExcerpt: vi.fn(async () => ({ deleted: true })),
    acknowledgeExcerptFocus: vi.fn(async () => ({ acknowledged: true })),
    readExcerptPage: vi.fn(async () => ({ sentences: [], truncated: false, source: '' })),
    ...overrides,
  };
}
