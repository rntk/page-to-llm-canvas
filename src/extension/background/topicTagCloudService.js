import { executeDecisionWithRetry } from '../../core/llm/decisionRetry.js';
import { buildTopicTagClouds } from '../../core/pipeline/topicTagClouds.js';
import { rankTopicWords } from '../../core/pipeline/topicTagCloudRanking.js';
import { projectArticleView } from '../../domain/articleView.js';
import { projectSummaryTreeTopics } from '../../domain/summaryTreeTopicProjection.js';
import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import { readSummaryTree, SUMMARY_TREE_STATUS } from '../../shared/runtime/summaryTree.js';
import { LLM_TASK_TYPES } from '../../shared/runtime/telemetry.js';
import { TOPIC_SOURCE } from '../../shared/runtime/topicSources.js';
import {
  isTopicTagCloudCacheable,
  readSavedTopicTagClouds,
  sameTopicTagCloudRevision,
  TOPIC_TAG_CLOUD_VERSION,
  topicTagCloudRevision,
} from '../../shared/runtime/topicTagClouds.js';
import { CHAT_KEEPALIVE_INTERVAL_MS } from './chatCompletionService.js';

function articleForTagClouds(record, source) {
  if (source === TOPIC_SOURCE.PIPELINE) return projectArticleView(record);
  const summaryTree = readSummaryTree(record.summary_tree, record.contentRevision);
  const projected =
    summaryTree.status !== SUMMARY_TREE_STATUS.RUNNING &&
    projectSummaryTreeTopics(summaryTree.tree);
  if (!projected) throw new Error('Build the summary tree before generating its topic tags.');
  return projectArticleView({ ...record, ...projected });
}

const CHANGED_MESSAGE = 'The topics changed while tags were being generated. Try again.';
const STOPPED_MESSAGE = 'Topic tag generation was stopped.';

/**
 * Generates cached tag clouds on the first request for a saved topic source.
 * Concurrent viewers share work for the same snapshot.
 * @param {object} deps Service dependencies.
 * @param {Function} deps.readRecordView Read the record without processing checkpoints.
 * @param {Function} deps.putRecordTopicTagClouds Save a revision-guarded cloud.
 * @param {Function} deps.getTagCloudProvider Read the decision provider for ranking.
 * @param {Function} deps.bindDecide Bind the provider snapshot to transport and metrics.
 * @param {Function} [deps.keepAlive] Touch a browser API during long-running work.
 */
export function createTopicTagCloudService({
  readRecordView,
  putRecordTopicTagClouds,
  getTagCloudProvider,
  bindDecide,
  keepAlive = async () => {},
}) {
  const jobs = new Map();

  async function get(key, source) {
    const record = await readRecordView(key);
    if (record?.status !== PIPELINE_STATUS.DONE)
      throw new Error('Finish processing the article before generating its topic tags.');
    const revision = topicTagCloudRevision(record, source);
    const article = articleForTagClouds(record, source);
    const savedCloud = readSavedTopicTagClouds(record, source, revision);
    if (savedCloud) return savedCloud;

    const cacheable = isTopicTagCloudCacheable(source, revision);
    const legacyTree = cacheable ? null : JSON.stringify(record.summary_tree);
    const id = JSON.stringify([key, source, record.pipelineRunId, revision, legacyTree]);
    const existing = jobs.get(id);
    if (existing) return existing.promise;

    const controller = new AbortController();
    const promise = generate({
      key,
      source,
      record,
      article,
      revision,
      cacheable,
      legacyTree,
      signal: controller.signal,
    }).finally(() => jobs.delete(id));
    jobs.set(id, { key, controller, promise });
    return promise;
  }

  async function generate({
    key,
    source,
    record,
    article,
    revision,
    cacheable,
    legacyTree,
    signal,
  }) {
    const heartbeat = setInterval(() => {
      Promise.resolve()
        .then(keepAlive)
        .catch(() => {});
    }, CHAT_KEEPALIVE_INTERVAL_MS);
    let provider;
    try {
      provider = await getTagCloudProvider();
      signal.throwIfAborted();
      if (!provider)
        throw new Error(
          'Select a Decisions provider under Topic tag clouds in Options to generate topic tags.',
        );
      const boundDecide = await bindDecide(provider, key);
      signal.throwIfAborted();
      const decide = (state, questions, options) =>
        executeDecisionWithRetry(
          () => boundDecide(state, questions, { ...options, taskType: LLM_TASK_TYPES.TOPIC_TAGS }),
          { signal: options.signal },
        );
      const byPath = await buildTopicTagClouds({
        ...article,
        signal,
        rank: (input) =>
          rankTopicWords({ ...input, decide, contextWindowTokens: provider.contextWindowTokens }),
      });
      signal.throwIfAborted();
      const cloud = { version: TOPIC_TAG_CLOUD_VERSION, ...revision, byPath };
      if (cacheable) {
        const saved = await putRecordTopicTagClouds(key, source, cloud, record.pipelineRunId);
        if (!saved) throw new Error(CHANGED_MESSAGE);
      } else {
        const current = await readRecordView(key);
        if (
          current?.status !== PIPELINE_STATUS.DONE ||
          current.pipelineRunId !== record.pipelineRunId ||
          !sameTopicTagCloudRevision(revision, topicTagCloudRevision(current, source)) ||
          JSON.stringify(current.summary_tree) !== legacyTree
        )
          throw new Error(CHANGED_MESSAGE);
      }
      signal.throwIfAborted();
      return cloud;
    } catch (error) {
      if (signal.aborted) throw new Error(STOPPED_MESSAGE);
      const message = String(error?.message || error);
      throw new Error(provider?.token ? message.split(provider.token).join('[redacted]') : message);
    } finally {
      clearInterval(heartbeat);
    }
  }

  return {
    get,
    cancel(key) {
      for (const job of jobs.values()) {
        if (key === undefined || job.key === key) job.controller.abort();
      }
    },
    activeJobs: () => Array.from(jobs.values(), ({ promise }) => promise),
  };
}
