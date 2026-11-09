// Project-owned topic merging. Builds never write to their source records and
// resume from saved checkpoints after a worker restart, like an article pipeline.
import { canonicalPageUrl } from '../../core/storage/keys.js';
import {
  diffProjectRecords,
  hasProjectTopicSource,
  projectTopicSourceRevision,
} from '../../core/projects/projectTopicTree.js';
import {
  readSummaryTree,
  canRecoverSummaryTree,
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
 * @param {object} [deps.alarms] Background recovery alarms.
 * @param {object} [deps.failureBreaker] Shared pipeline recovery breaker.
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
  alarms,
  failureBreaker,
  now = Date.now,
  createId = () => crypto.randomUUID(),
}) {
  // Bounded across projects; legacy records without a marker always get read.
  const recordCache = new Map();
  async function readSource(candidate) {
    const cached = recordCache.get(candidate.key);
    if (
      candidate.projectTopicRevision &&
      cached?.projectTopicRevision === candidate.projectTopicRevision &&
      cached.status === candidate.status
    )
      return cached;
    const saved = await readRecord(candidate.key);
    recordCache.delete(candidate.key);
    if (
      saved &&
      candidate.projectTopicRevision &&
      saved.projectTopicRevision === candidate.projectTopicRevision
    ) {
      recordCache.set(candidate.key, saved);
      if (recordCache.size > 32) recordCache.delete(recordCache.keys().next().value);
    }
    return saved;
  }

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
        const saved = await readSource(candidate);
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

  function updateProject(projectId, mutate) {
    if (projectStore.updateProject) return projectStore.updateProject(projectId, mutate);
    return projectStore.update((projects) =>
      projects.map((project) => (project.id === projectId ? mutate(project) || project : project)),
    );
  }

  async function saveOwned(projectId, runId, tree) {
    let owned = false;
    await updateProject(projectId, (project) => {
      if (project.topic_tree?.runId !== runId) return null;
      owned = true;
      return {
        ...project,
        topic_tree: structuredClone({ ...tree, backgroundRecovery: true, runId }),
      };
    });
    if (!owned) throw new Error('This project topic build was superseded or deleted.');
  }

  async function run(projectId, { signal, fresh }) {
    const source = await inputs(projectId);
    if (!source.topicCount)
      throw new Error('No completed saved topics are available in this project.');
    const runId = createId();
    const prior = source.view.project.topic_tree;
    // A finished tree is extended with the page changes, so it is kept as is
    // until the first save replaces it; other checkpoints need identical sources.
    const keep =
      !fresh && !!prior && (!!prior.rootId || prior.contentRevision === source.sourceRevision);
    const initial = {
      ...(keep ? prior : {}),
      version: SUMMARY_TREE_VERSION,
      backgroundRecovery: true,
      status: SUMMARY_TREE_STATUS.RUNNING,
      stage: 'passages',
      contentRevision: source.sourceRevision,
      sourceRevision: source.sourceRevision,
      nodes: keep ? prior.nodes || {} : {},
      runId,
      error: null,
      updatedAt: now(),
    };
    await updateProject(projectId, (project) => ({ ...project, topic_tree: initial }));
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

  async function canRecoverProject(projectId) {
    const source = await inputs(projectId);
    return canRecoverSummaryTree({
      summary_tree: source.view.project.topic_tree,
      contentRevision: source.sourceRevision,
    });
  }

  const jobs = createSummaryTreeJobs({
    runSummaryTree: run,
    logger,
    alarms,
    alarmName: 'project-topic-tree-keepalive',
    failureBreaker,
    async onStop(projectId) {
      let cancelled = false;
      await updateProject(projectId, (project) => {
        if (project.topic_tree?.status !== SUMMARY_TREE_STATUS.RUNNING) return null;
        cancelled = true;
        return {
          ...project,
          topic_tree: {
            ...project.topic_tree,
            status: SUMMARY_TREE_STATUS.CANCELLED,
            error: 'Stopped.',
            updatedAt: now(),
          },
        };
      });
      return cancelled;
    },
    canRecover: canRecoverProject,
    async onFailure(projectId, error, { signal }) {
      await updateProject(projectId, (project) => {
        if (project.topic_tree?.status !== SUMMARY_TREE_STATUS.RUNNING) return null;
        return {
          ...project,
          topic_tree: {
            ...project.topic_tree,
            status: signal.aborted ? SUMMARY_TREE_STATUS.CANCELLED : SUMMARY_TREE_STATUS.ERROR,
            error: signal.aborted ? 'Stopped.' : String(error?.message || error),
            updatedAt: now(),
          },
        };
      });
    },
    async prepareRun(projectId, { fresh }) {
      const source = await inputs(projectId);
      if (!source.topicCount)
        throw new Error('No completed saved topics are available in this project.');
      await updateProject(projectId, (project) => ({
        ...project,
        topic_tree: {
          ...(!fresh &&
          (project.topic_tree?.rootId ||
            project.topic_tree?.contentRevision === source.sourceRevision)
            ? project.topic_tree
            : {}),
          version: SUMMARY_TREE_VERSION,
          backgroundRecovery: true,
          contentRevision: source.sourceRevision,
          status: SUMMARY_TREE_STATUS.RUNNING,
          error: null,
          updatedAt: now(),
        },
      }));
    },
    async listRunningKeys() {
      const keys = [];
      for (const project of await projectStore.list()) {
        if (
          !canRecoverSummaryTree({
            summary_tree: project.topic_tree,
            contentRevision: project.topic_tree?.contentRevision,
          })
        )
          continue;
        if (await canRecoverProject(project.id)) keys.push(project.id);
      }
      return keys;
    },
  });
  return {
    resumeInFlight: jobs.resumeInFlight,
    handleKeepAliveAlarm: jobs.handleKeepAliveAlarm,
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
      // Pages added, edited or removed since the saved tree was built.
      const changes =
        tree && Array.isArray(tree.records)
          ? diffProjectRecords(tree.records, source.records)
          : null;
      return {
        tree,
        status,
        eligiblePages: source.eligiblePages,
        skippedPages: source.skippedPages,
        topicCount: source.topicCount,
        stale:
          !!tree && (changes ? changes.total > 0 : tree.contentRevision !== source.sourceRevision),
        changes: changes && {
          added: changes.added.length,
          changed: changes.changed.length,
          removed: changes.removed.length,
        },
      };
    },
    async build(projectId, { fresh = false } = {}) {
      const source = await inputs(projectId);
      if (!source.topicCount)
        throw new Error(
          'Save and finish processing at least one project page before merging topics.',
        );
      const saved = source.view.project.topic_tree;
      if (
        !fresh &&
        saved?.status === SUMMARY_TREE_STATUS.DONE &&
        Array.isArray(saved.records) &&
        !diffProjectRecords(saved.records, source.records).total
      ) {
        return { started: false };
      }
      return { started: await jobs.start(projectId, { fresh }) };
    },
    async stop(projectId) {
      await projectStore.get(projectId);
      return { stopped: await jobs.stop(projectId) };
    },
  };
}
