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
  it('exposes merged topics and validates project merge actions', async () => {
    const topicTreeService = {
      getView: vi.fn(async () => ({ status: 'missing', tree: null })),
      build: vi.fn(async () => ({ started: true })),
      stop: vi.fn(async () => ({ stopped: true })),
    };
    const handlers = createProjectHandlers({
      projectService: makeService(),
      pageChatService: {},
      topicTreeService,
    });
    expect(handlers[MSG.buildProjectTopicTree].validate({ projectId: 'a', fresh: 'true' })).toBe(
      'invalid fresh',
    );
    expect(handlers[MSG.buildProjectTopicTree].validate({ fresh: true })).toBe('invalid projectId');
    expect(
      await handlers[MSG.buildProjectTopicTree].handle({ projectId: 'a', fresh: true }),
    ).toEqual({ ok: true, started: true });
    expect(topicTreeService.build).toHaveBeenCalledWith('a', { fresh: true });
    expect(await handlers[MSG.stopProjectTopicTree].handle({ projectId: 'a' })).toEqual({
      ok: true,
      stopped: true,
    });
    expect(await handlers[MSG.getProjectView].handle({ projectId: 'a' })).toMatchObject({
      topicMerge: { status: 'missing', tree: null },
    });
  });

  it('keeps every project action extension-page only', () => {
    for (const [type, entry] of Object.entries(
      createProjectHandlers({ projectService: makeService(), pageChatService: {} }),
    )) {
      expect(entry.requiresExtensionPage, type).toBe(true);
    }
  });

  it('validates group and project ids', () => {
    const handlers = createProjectHandlers({ projectService: makeService(), pageChatService: {} });
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
    const handlers = createProjectHandlers({ projectService, pageChatService: {} });
    expect(await handlers[MSG.getProjectView].handle({ projectId: 'a' })).toEqual({
      ok: true,
      project: { id: 'a' },
      isOpen: true,
      tabs: [],
      excerpts: [],
      focusExcerptId: null,
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

  it('validates and forwards per-page chat requests', async () => {
    const pageChatService = {
      getPageChat: vi.fn(async () => ({ kind: 'page', key: 'page:https://a.test/', url: 'x' })),
      capturePageText: vi.fn(async () => ({ sentences: ['One.'], truncated: false })),
    };
    const handlers = createProjectHandlers({ projectService: makeService(), pageChatService });
    for (const type of [MSG.getProjectPageChat, MSG.captureProjectPageText]) {
      expect(handlers[type].requiresExtensionPage, type).toBe(true);
      expect(handlers[type].validate({ tabId: 1 }), type).toBe('invalid projectId');
      expect(handlers[type].validate({ projectId: 'a', tabId: '1' }), type).toBe('invalid tabId');
      expect(handlers[type].validate({ projectId: 'a', tabId: 1 }), type).toBeNull();
    }
    expect(await handlers[MSG.getProjectPageChat].handle({ projectId: 'a', tabId: 3 })).toEqual({
      ok: true,
      source: { kind: 'page', key: 'page:https://a.test/', url: 'x' },
    });
    expect(pageChatService.getPageChat).toHaveBeenCalledWith('a', 3);
    expect(await handlers[MSG.captureProjectPageText].handle({ projectId: 'a', tabId: 3 })).toEqual(
      { ok: true, sentences: ['One.'], truncated: false },
    );
  });
});

describe('project excerpt handlers', () => {
  function makeExcerptService() {
    return {
      takeProjectExcerpts: vi.fn(async () => ({ excerpts: [{ id: 'e1' }], focusExcerptId: 'e1' })),
      deleteExcerpt: vi.fn(async () => ({ deleted: true })),
      readExcerptPage: vi.fn(async () => ({ sentences: ['One.'], truncated: false })),
      deleteProject: vi.fn(async () => ({ deleted: true })),
    };
  }

  it('merges excerpts into the project view', async () => {
    const excerptService = makeExcerptService();
    const handlers = createProjectHandlers({
      projectService: makeService(),
      pageChatService: {},
      excerptService,
    });
    expect(await handlers[MSG.getProjectView].handle({ projectId: 'a' })).toEqual({
      ok: true,
      project: { id: 'a' },
      isOpen: true,
      tabs: [],
      excerpts: [{ id: 'e1' }],
      focusExcerptId: 'e1',
    });
  });

  it('validates and forwards excerpt requests, and deletes projects with their excerpts', async () => {
    const excerptService = makeExcerptService();
    const projectService = makeService();
    const handlers = createProjectHandlers({ projectService, pageChatService: {}, excerptService });
    for (const type of [MSG.deleteProjectExcerpt, MSG.readProjectExcerptPage]) {
      expect(handlers[type].requiresExtensionPage, type).toBe(true);
      expect(handlers[type].validate({ excerptId: 'e' }), type).toBe('invalid projectId');
      expect(handlers[type].validate({ projectId: 'a' }), type).toBe('invalid excerptId');
      expect(handlers[type].validate({ projectId: 'a', excerptId: 'e' }), type).toBeNull();
    }
    await handlers[MSG.deleteProjectExcerpt].handle({ projectId: 'a', excerptId: 'e1' });
    expect(excerptService.deleteExcerpt).toHaveBeenCalledWith('a', 'e1');
    expect(
      await handlers[MSG.readProjectExcerptPage].handle({ projectId: 'a', excerptId: 'e1' }),
    ).toEqual({ ok: true, sentences: ['One.'], truncated: false });
    await handlers[MSG.deleteProject].handle({ projectId: 'a' });
    expect(excerptService.deleteProject).toHaveBeenCalledWith('a');
    expect(projectService.deleteProject).not.toHaveBeenCalled();
  });

  it('rejects excerpt requests without an excerpt service', async () => {
    const handlers = createProjectHandlers({ projectService: makeService(), pageChatService: {} });
    await expect(
      handlers[MSG.readProjectExcerptPage].handle({ projectId: 'a', excerptId: 'e' }),
    ).rejects.toThrow('excerpts are not available');
  });
});
