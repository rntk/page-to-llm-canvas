import { describe, it, expect, vi } from 'vitest';
import { MSG } from '../../../shared/runtime/messages.js';
import { createProjectHandlers } from './projectHandlers.js';

function makeService() {
  return {
    listProjectsOverview: vi.fn(async () => ({ projects: [], ungroupedGroups: [] })),
    createProjectFromGroup: vi.fn(async () => ({ project: { id: 'a' }, createdProject: true })),
    openProjectForGroup: vi.fn(async () => ({ project: { id: 'a' }, tabId: 1 })),
    openProject: vi.fn(async () => ({ isOpen: false })),
    focusGroup: vi.fn(async () => ({ isOpen: true, tabId: 2 })),
    deleteProject: vi.fn(async () => ({ deleted: true })),
    getProjectView: vi.fn(async () => ({ project: { id: 'a' }, isOpen: true, tabs: [] })),
  };
}

describe('project handlers', () => {
  it('keeps every project action extension-page only', () => {
    for (const [type, entry] of Object.entries(
      createProjectHandlers({ projectService: makeService() }),
    )) {
      expect(entry.requiresExtensionPage, type).toBe(true);
    }
  });

  it('validates group and project ids', () => {
    const handlers = createProjectHandlers({ projectService: makeService() });
    expect(handlers[MSG.openProjectForGroup].validate({ groupId: -1 })).toBe('invalid groupId');
    expect(handlers[MSG.createProjectFromGroup].validate({ groupId: '3' })).toBe('invalid groupId');
    expect(handlers[MSG.openProjectForGroup].validate({ groupId: 3 })).toBeNull();
    for (const type of [
      MSG.openProject,
      MSG.focusProjectGroup,
      MSG.deleteProject,
      MSG.getProjectView,
    ]) {
      expect(handlers[type].validate({}), type).toBe('invalid projectId');
      expect(handlers[type].validate({ projectId: 'a' }), type).toBeNull();
    }
    expect(handlers[MSG.listProjectsOverview].validate({})).toBeNull();
  });

  it('forwards to the service and wraps results with ok', async () => {
    const projectService = makeService();
    const handlers = createProjectHandlers({ projectService });
    expect(await handlers[MSG.getProjectView].handle({ projectId: 'a' })).toEqual({
      ok: true,
      project: { id: 'a' },
      isOpen: true,
      tabs: [],
    });
    await handlers[MSG.openProjectForGroup].handle({ groupId: 4 });
    expect(projectService.openProjectForGroup).toHaveBeenCalledWith(4);
    await handlers[MSG.focusProjectGroup].handle({ projectId: 'b' });
    expect(projectService.focusGroup).toHaveBeenCalledWith('b');
    expect(await handlers[MSG.listProjectsOverview].handle({})).toEqual({
      ok: true,
      projects: [],
      ungroupedGroups: [],
    });
  });
});
