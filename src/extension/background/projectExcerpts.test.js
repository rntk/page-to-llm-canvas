import { describe, expect, it, vi } from 'vitest';
import { createProjectExcerptService } from './projectExcerpts.js';
import { createExcerptStore } from '../../core/projects/excerpts.js';

function setup({ selection = 'Selected text.', sendTabMessage } = {}) {
  const data = {};
  const excerptStore = createExcerptStore({
    get: async (key) => ({ [key]: data[key] }),
    set: async (items) => Object.assign(data, items),
    queue: (_key, fn) => fn(),
    key: 'excerpts',
  });
  const projectService = {
    groupForTab: vi.fn(async (tab) => (tab ? 7 : null)),
    createProjectFromGroup: vi.fn(async () => ({ project: { id: 'p1' } })),
    openProjectForGroup: vi.fn(async () => ({})),
    deleteProject: vi.fn(async () => ({ deleted: true })),
  };
  const pageChatService = { readPageText: vi.fn(async () => ({ sentences: ['a'] })) };
  const deleteChats = vi.fn(async () => 1);
  let ids = 0;
  const service = createProjectExcerptService({
    projectService,
    pageChatService,
    excerptStore,
    deleteChats,
    sendTabMessage:
      sendTabMessage ?? vi.fn(async () => ({ status: 'ok', text: `${selection}\nLine two.` })),
    now: () => 10,
    createId: () => `ex${(ids += 1)}`,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  return { service, projectService, pageChatService, deleteChats, excerptStore };
}

const tab = { id: 3, url: 'https://a.test/page#top', title: 'A page' };

describe('createProjectExcerptService', () => {
  it('stores the page selection, then opens the project with it in focus', async () => {
    const { service, projectService, excerptStore } = setup();
    const result = await service.openExcerptFromSelection(tab, {
      selectionText: 'flat',
      frameId: 0,
    });

    expect(result.excerpt).toMatchObject({
      id: 'ex1',
      projectId: 'p1',
      url: 'https://a.test/page',
      title: 'A page',
      text: 'Selected text.\nLine two.',
    });
    expect(projectService.openProjectForGroup).toHaveBeenCalledWith(7);
    expect(await service.takeProjectExcerpts('p1')).toEqual({
      excerpts: [result.excerpt],
      focusExcerptId: 'ex1',
    });
    expect((await excerptStore.read()).focus).toBe(null);
  });

  it('falls back to the menu selection when the page cannot answer', async () => {
    const { service } = setup({
      sendTabMessage: vi.fn(async () => Promise.reject(new Error('x'))),
    });
    const result = await service.openExcerptFromSelection(tab, { selectionText: 'From menu.' });
    expect(result.excerpt.text).toBe('From menu.');
  });

  it('does not ask a subframe selection from the top frame', async () => {
    const sendTabMessage = vi.fn();
    const { service } = setup({ sendTabMessage });
    await service.openExcerptFromSelection(tab, { selectionText: 'In frame.', frameId: 4 });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('ignores an empty selection', async () => {
    const { service, projectService } = setup({
      sendTabMessage: vi.fn(async () => ({ status: 'ok', text: '' })),
    });
    expect(await service.openExcerptFromSelection(tab, { selectionText: '  ' })).toBe(null);
    expect(projectService.groupForTab).not.toHaveBeenCalled();
  });

  it('deletes an excerpt with its chats, and a project with all of its excerpts', async () => {
    const { service, deleteChats, projectService } = setup();
    await service.openExcerptFromSelection(tab);
    await service.openExcerptFromSelection(tab);

    expect(await service.deleteExcerpt('p1', 'ex1')).toEqual({ deleted: true });
    expect(deleteChats).toHaveBeenCalledWith('excerpt:ex1');
    expect(await service.deleteExcerpt('p1', 'ex1')).toEqual({ deleted: false });

    expect(await service.deleteProject('p1')).toEqual({ deleted: true });
    expect(projectService.deleteProject).toHaveBeenCalledWith('p1');
    expect(deleteChats).toHaveBeenCalledWith('excerpt:ex2');
    expect((await service.takeProjectExcerpts('p1')).excerpts).toEqual([]);
  });

  it('reads the excerpt’s page by its URL', async () => {
    const { service, pageChatService } = setup();
    await service.openExcerptFromSelection(tab);
    await service.readExcerptPage('p1', 'ex1');
    expect(pageChatService.readPageText).toHaveBeenCalledWith('p1', 'https://a.test/page');
    await expect(service.readExcerptPage('p1', 'missing')).rejects.toThrow('excerpt not found');
  });
});
