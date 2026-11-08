// Project-owned topic merging. Builds never write to their source records and
// are explicitly resumed after a worker restart, like an article summary tree.
import { canonicalPageUrl } from '../../core/storage/keys.js';
import {
  hasProjectTopicSource,
  projectTopicSourceRevision,
} from '../../core/projects/projectTopicTree.js';
import {
  readSummaryTree,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../shared/runtime/summaryTree.js';
import { createSummaryTreeJobs } from './summaryTreeJobs.js';

/**
 * @param {object} deps
 * @param {object} deps.projectService
 * @param {object} deps.projectStore
 * @param {function(): Promise<object[]>} deps.listRecords
 * @param {function(string): Promise<object|null>} deps.readRecord
 * @param {Function} deps.runProjectTopicTree
 * @param {object} deps.logger
 * @param {function(): number} [deps.now]
 * @param {function(): string} [deps.createId]
 */
export function createProjectTopicTreeService({
  projectService,
  projectStore,
  listRecords,
  readRecord,
  runProjectTopicTree,
  logger,
  now = Date.now,
  createId = () => crypto.randomUUID(),
}) {
  async function inputs(projectId, providedView) {
    const view = providedView || (await projectService.getProjectView(projectId));
    const projections = await listRecords();
    const byUrl = new Map();
    for (const projection of projections) {
      const url = canonicalPageUrl(projection.sourceUrl);
      if (!url) continue;
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(projection);
    }
    const seenUrls = new Set();
    const seenRecords = new Set();
    const records = [];
    const eligiblePages = [];
    const skippedPages = [];
    const tabs = [...view.tabs].sort((a, b) => String(a.url).localeCompare(String(b.url)));
    for (const tab of tabs) {
      const url = canonicalPageUrl(tab.url || '');
      if (!url || seenUrls.has(url)) continue;
      seenUrls.add(url);
      const page = { title: tab.title || url, url };
      const candidates = byUrl.get(url) || [];
      // A failed or newer pending capture must not hide a completed split.
      const completed = candidates.filter((item) => item.status === 'done');
      let record = null;
      for (const candidate of completed) {
        const saved = await readRecord(candidate.key);
        if (hasProjectTopicSource(saved)) {
          record = saved;
          break;
        }
      }
      if (!record) {
        skippedPages.push({
          ...page,
          reason: candidates.length
            ? 'Finish processing this page before merging its topics.'
            : 'Save and process this page to include its topics.',
        });
        continue;
      }
      if (seenRecords.has(record.key)) continue;
      seenRecords.add(record.key);
      records.push({ ...record, title: page.title });
      eligiblePages.push({ ...page, key: record.key, topicCount: record.topics.length });
    }
    return {
      view,
      records,
      eligiblePages,
      skippedPages,
      sourceRevision: projectTopicSourceRevision(records),
      topicCount: records.reduce((sum, record) => sum + record.topics.length, 0),
    };
  }

  async function saveOwned(projectId, runId, tree) {
    let owned = false;
    await projectStore.update((projects) => {
      const next = projects.map((project) => {
        if (project.id !== projectId || project.topic_tree?.runId !== runId) return project;
        owned = true;
        return { ...project, topic_tree: structuredClone({ ...tree, runId }) };
      });
      return owned ? next : null;
    });
    if (!owned) throw new Error('This project topic build was superseded or deleted.');
  }

  async function run(projectId, { signal, fresh }) {
    const source = await inputs(projectId);
    if (!source.topicCount)
      throw new Error('No completed saved topics are available in this project.');
    const runId = createId();
    const prior = source.view.project.topic_tree;
    const sameSource = prior?.contentRevision === source.sourceRevision;
    const initial = {
      ...(sameSource && !fresh ? prior : {}),
      version: SUMMARY_TREE_VERSION,
      status: SUMMARY_TREE_STATUS.RUNNING,
      stage: 'passages',
      contentRevision: source.sourceRevision,
      sourceRevision: source.sourceRevision,
      nodes: sameSource && !fresh ? prior.nodes || {} : {},
      runId,
      error: null,
      updatedAt: now(),
    };
    await projectStore.update((projects) =>
      projects.map((project) =>
        project.id === projectId ? { ...project, topic_tree: initial } : project,
      ),
    );
    try {
      signal.throwIfAborted();
      await runProjectTopicTree({
        records: source.records,
        prior,
        title: source.view.project.title,
        signal,
        fresh,
        async saveSummaryTree(tree) {
          signal.throwIfAborted();
          const latest = await inputs(projectId);
          if (latest.sourceRevision !== source.sourceRevision) {
            throw new Error(
              'The project pages or their saved topics changed. Rebuild to include the current pages.',
            );
          }
          await saveOwned(projectId, runId, tree);
        },
      });
    } catch (error) {
      const project = await projectStore.get(projectId);
      if (project?.topic_tree?.runId !== runId) return;
      await saveOwned(projectId, runId, {
        ...project.topic_tree,
        status: signal.aborted ? SUMMARY_TREE_STATUS.CANCELLED : SUMMARY_TREE_STATUS.ERROR,
        error: signal.aborted ? 'Stopped.' : String(error?.message || error),
        updatedAt: now(),
      });
      if (!signal.aborted) logger.error('project topic merge failed:', projectId, error);
    }
  }

  const jobs = createSummaryTreeJobs({ runSummaryTree: run, logger });
  return {
    async getView(projectId, providedView) {
      const source = await inputs(projectId, providedView);
      const saved = source.view.project.topic_tree;
      const { tree, status } = readSummaryTree(
        {
          summary_tree: saved,
          contentRevision: saved?.contentRevision,
        },
        now(),
      );
      return {
        tree,
        status,
        eligiblePages: source.eligiblePages,
        skippedPages: source.skippedPages,
        topicCount: source.topicCount,
        stale: !!tree && tree.contentRevision !== source.sourceRevision,
      };
    },
    async build(projectId, { fresh = false } = {}) {
      const source = await inputs(projectId);
      if (!source.topicCount)
        throw new Error(
          'Save and finish processing at least one project page before merging topics.',
        );
      return { started: jobs.start(projectId, { fresh }) };
    },
    async stop(projectId) {
      await projectStore.get(projectId);
      return { stopped: jobs.stop(projectId) };
    },
  };
}
