import { describe, expect, it, vi } from 'vitest';
import {
  projectRecordRevision,
  projectTopicSourceRevision,
} from '../../core/projects/projectTopicTree.js';
import { createProjectTopicTreeService } from './projectTopicTree.js';

function fixture() {
  let projects = [{ id: 'p', title: 'Research', groupId: 3 }];
  const records = [
    {
      key: 'a',
      status: 'done',
      sourceUrl: 'https://a.test/#saved',
      contentRevision: 'a1',
      sentences: ['First.'],
      topics: [{ name: 'One', sentences: [1] }],
    },
    { key: 'b', status: 'splitting', sourceUrl: 'https://b.test/', sentences: ['Pending.'] },
  ];
  const tabs = [
    { id: 1, title: 'Article A', url: 'https://a.test/#one' },
    { id: 2, title: 'Duplicate A', url: 'https://a.test/#two' },
    { id: 3, title: 'Article B', url: 'https://b.test/' },
    { id: 4, title: 'Unsaved', url: 'https://new.test/' },
  ];
  const projectStore = {
    list: async () => projects,
    get: async (id) => projects.find((project) => project.id === id),
    update: async (mutate) => {
      const next = mutate(projects);
      if (next) projects = next;
      return projects;
    },
  };
  const runProjectTopicTree = vi.fn(async ({ saveSummaryTree, records: sources }) => {
    await saveSummaryTree({
      version: 1,
      status: 'done',
      contentRevision: projects[0].topic_tree.contentRevision,
      rootId: 'n1',
      nodes: {},
      records: sources.map((source) => ({
        key: source.key,
        contentRevision: source.contentRevision || null,
        revision: projectRecordRevision(source),
      })),
      updatedAt: 100,
    });
  });
  const logger = { error: vi.fn() };
  const readRecord = vi.fn(async (key) => records.find((record) => record.key === key));
  const createService = () =>
    createProjectTopicTreeService({
      projectStore,
      projectService: { getProjectView: async () => ({ project: projects[0], tabs }) },
      listRecords: async () =>
        records.map(({ key, sourceUrl, status, projectTopicRevision }) => ({
          key,
          sourceUrl,
          status,
          projectTopicRevision,
        })),
      readRecord,
      runProjectTopicTree,
      logger,
      now: () => 100,
      createId: () => 'run',
    });
  return {
    service: createService(),
    createService,
    records,
    projectStore,
    runProjectTopicTree,
    tabs,
    logger,
    readRecord,
  };
}

const waitDone = async (store, expected = 'done') => {
  await vi.waitFor(async () => expect((await store.get('p')).topic_tree?.status).toBe(expected));
};

describe('project topic tree service', () => {
  it('automatically resumes saved progress in a replacement worker with no project view mounted', async () => {
    const { createService, projectStore, runProjectTopicTree, records } = fixture();
    await projectStore.update((projects) =>
      projects.map((project) => ({
        ...project,
        topic_tree: {
          version: 1,
          status: 'running',
          contentRevision: projectTopicSourceRevision([records[0]]),
          backgroundRecovery: true,
          nodes: { passage: { title: 'Saved work' } },
          updatedAt: 1,
        },
      })),
    );
    runProjectTopicTree.mockImplementationOnce(async ({ prior, saveSummaryTree }) => {
      expect(prior.nodes.passage.title).toBe('Saved work');
      await saveSummaryTree({
        ...(await projectStore.get('p')).topic_tree,
        status: 'done',
        rootId: 'n1',
      });
    });
    await createService().resumeInFlight();
    await waitDone(projectStore);
    expect(runProjectTopicTree).toHaveBeenCalledTimes(1);
    await createService().resumeInFlight();
    expect(runProjectTopicTree).toHaveBeenCalledTimes(1);
  });

  it('leaves legacy interrupted and source-mismatched merges for manual Resume', async () => {
    const { service, projectStore, records, runProjectTopicTree } = fixture();
    for (const tree of [
      { contentRevision: projectTopicSourceRevision([records[0]]), updatedAt: 1 },
      { contentRevision: 'outdated', updatedAt: 100, backgroundRecovery: true },
    ]) {
      await projectStore.update((projects) =>
        projects.map((project) => ({
          ...project,
          topic_tree: { version: 1, status: 'running', ...tree },
        })),
      );
      await service.resumeInFlight();
      expect(runProjectTopicTree).not.toHaveBeenCalled();
      expect((await projectStore.get('p')).topic_tree.status).toBe('running');
    }
  });

  it('persists Stop for an orphaned running merge and never recovers it', async () => {
    const { service, projectStore, records, runProjectTopicTree } = fixture();
    await projectStore.update((projects) =>
      projects.map((project) => ({
        ...project,
        topic_tree: {
          version: 1,
          status: 'running',
          backgroundRecovery: true,
          contentRevision: projectTopicSourceRevision([records[0]]),
          nodes: { saved: { title: 'Checkpoint' } },
        },
      })),
    );
    expect(await service.stop('p')).toEqual({ stopped: true });
    expect((await projectStore.get('p')).topic_tree).toMatchObject({
      status: 'cancelled',
      nodes: { saved: { title: 'Checkpoint' } },
    });
    await service.resumeInFlight();
    expect(runProjectTopicTree).not.toHaveBeenCalled();
    expect(await service.stop('p')).toEqual({ stopped: false });
  });

  it('reuses revisioned sources and reloads changed sources', async () => {
    const { service, records, readRecord } = fixture();
    records[0].projectTopicRevision = 'source-1';
    await service.getView('p');
    await service.getView('p');
    expect(readRecord).toHaveBeenCalledTimes(1);
    records[0] = { ...records[0], projectTopicRevision: 'source-2' };
    await service.getView('p');
    expect(readRecord).toHaveBeenCalledTimes(2);
    delete records[0].projectTopicRevision;
    await service.getView('p');
    await service.getView('p');
    expect(readRecord).toHaveBeenCalledTimes(4);
  });

  it('selects completed records by canonical URL once and explains skipped pages', async () => {
    const { service } = fixture();
    const view = await service.getView('p');
    expect(view).toMatchObject({ status: 'missing', tree: null, topicCount: 1, stale: false });
    expect(view.eligiblePages).toEqual([
      { key: 'a', title: 'Article A', url: 'https://a.test/', topicCount: 1 },
    ]);
    expect(view.skippedPages).toHaveLength(2);
    expect(view.skippedPages[0].reason).toMatch(/Finish processing/);
  });

  it('persists only the project tree and exposes input changes without discarding the old tree', async () => {
    const { service, records, projectStore, runProjectTopicTree } = fixture();
    const before = structuredClone(records);
    expect(await service.build('p')).toEqual({ started: true });
    await waitDone(projectStore);
    expect(runProjectTopicTree).toHaveBeenCalledWith(
      expect.objectContaining({ fresh: false, records: [expect.objectContaining({ key: 'a' })] }),
    );
    expect(records).toEqual(before);
    expect((await service.getView('p')).stale).toBe(false);
    records[0].topics[0].name = 'New split';
    expect(await service.getView('p')).toMatchObject({
      status: 'done',
      stale: true,
      changes: { added: 0, changed: 1, removed: 0 },
    });
  });

  it('reports added pages, skips no-op builds, and keeps the finished tree while extending it', async () => {
    const { service, records, projectStore, runProjectTopicTree, tabs } = fixture();
    await service.build('p');
    await waitDone(projectStore);
    expect(await service.build('p')).toEqual({ started: false });
    expect(runProjectTopicTree).toHaveBeenCalledTimes(1);

    records[1] = {
      key: 'b',
      status: 'done',
      sourceUrl: 'https://b.test/',
      contentRevision: 'b1',
      sentences: ['Second.'],
      topics: [{ name: 'Two', sentences: [1] }],
    };
    // Tab order must not matter; only the new page counts as a change.
    tabs.reverse();
    expect(await service.getView('p')).toMatchObject({
      stale: true,
      changes: { added: 1, changed: 0, removed: 0 },
    });
    const saved = (await projectStore.get('p')).topic_tree;
    runProjectTopicTree.mockImplementationOnce(async ({ prior }) => {
      // The run starts from the finished tree rather than an emptied one.
      expect(prior.rootId).toBe('n1');
      expect((await projectStore.get('p')).topic_tree.rootId).toBe(saved.rootId);
    });
    expect(await service.build('p')).toEqual({ started: true });
    await vi.waitFor(() => expect(runProjectTopicTree).toHaveBeenCalledTimes(2));
  });

  it('stops an active build, persists the partial tree, and allows resume', async () => {
    const { service, projectStore, runProjectTopicTree } = fixture();
    runProjectTopicTree.mockImplementationOnce(async ({ signal, saveSummaryTree }) => {
      await saveSummaryTree({
        ...(await projectStore.get('p')).topic_tree,
        nodes: { n0: { title: 'Checkpoint' } },
      });
      await new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    await service.build('p');
    await vi.waitFor(() => expect(runProjectTopicTree).toHaveBeenCalled());
    expect(await service.build('p')).toEqual({ started: false });
    expect(await service.stop('p')).toEqual({ stopped: true });
    await waitDone(projectStore, 'cancelled');
    expect((await projectStore.get('p')).topic_tree.nodes.n0.title).toBe('Checkpoint');
    await vi.waitFor(async () => expect((await service.build('p')).started).toBe(true));
    await waitDone(projectStore);
  });

  it('rejects checkpoint writes when project membership changes during generation', async () => {
    const { service, projectStore, runProjectTopicTree, tabs } = fixture();
    runProjectTopicTree.mockImplementationOnce(async ({ saveSummaryTree }) => {
      tabs.splice(0, 2);
      await saveSummaryTree({ status: 'done' });
    });
    await service.build('p');
    await waitDone(projectStore, 'error');
    expect((await projectStore.get('p')).topic_tree.error).toMatch(/changed/);
    expect((await service.getView('p')).stale).toBe(true);
  });
});
