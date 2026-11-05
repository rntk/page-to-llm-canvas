// Summary tree: an alternative topics-and-summaries approach that runs beside
// the primary pipeline and never replaces its topics or summaries.
//
// 1. passages: every passage gets a brief summary citing its sentence numbers
//    (the grounding layer); passages without substance are skipped and a
//    passage that never gets a valid answer is marked failed.
// 2. topics: only the short passage digests are split recursively into 2-7
//    distinct sub-topics, one level more specific each time.
// 3. summaries: bottom-up along that structure, each level with its own
//    intent; every segment cites child claims, so any statement resolves down
//    to source sentences.
//
// With a decision provider, typed questions assign passages to sub-topics and
// check concrete claims against their citations; any decision failure falls
// back to the completion-only path. Completed nodes are checkpointed in the
// record's `summary_tree`, so a retry resumes rather than restarts.

import { mergeAbortSignals } from '../llm/abortSignals.js';
import { isCancellationError } from './cancellation.js';
import { SUMMARY_CONCURRENCY } from './pipelineConfig.js';
import { createClaimVerifier, generateSummaries } from './summaryTreeGeneration.js';
import {
  PASSAGE,
  PASSAGE_MAX_CHARS,
  PASSAGE_MIN_CHARS,
  PASSAGE_TARGET_CHARS,
  ROOT,
  TOPIC,
  addNode,
  buildPassages,
  topicIds,
  treeLevels,
} from './summaryTreeModel.js';
import { createSummaryTreeJudge, createSummaryTreeLlm } from './summaryTreeRequests.js';
import { TOPIC_BATCH_CHARS, buildTopics } from './summaryTreeTopics.js';
import { splitTopicPath } from '../../shared/runtime/topicPath.js';
import {
  SUMMARY_TREE_HEARTBEAT_MS,
  SUMMARY_TREE_STAGE,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../shared/runtime/summaryTree.js';

export { SUMMARY_TREE_STATUS, SUMMARY_TREE_VERSION };
const SAVE_INTERVAL_MS = 1000;

/**
 * Raised for an expected failure with a user-facing message.
 */
export class SummaryTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummaryTreeError';
  }
}

/**
 * Whether a saved tree belongs to this content and request identity.
 * @param {object|null|undefined} tree Saved `summary_tree`.
 * @param {object} record
 * @param {string} fingerprint Provider identity of the run.
 */
export function isSummaryTreeReusable(tree, record, fingerprint) {
  return (
    tree?.version === SUMMARY_TREE_VERSION &&
    typeof record?.contentRevision === 'string' &&
    tree.contentRevision === record.contentRevision &&
    tree.fingerprint === fingerprint &&
    tree.nodes !== null &&
    typeof tree.nodes === 'object'
  );
}

/**
 * Saved nodes a resumed run keeps: summarized passages always, the topic
 * structure only once it was complete. Failed passages are retried only while
 * topics are still to be built; afterwards they are no longer in the tree.
 * @param {object} tree Reusable saved tree.
 * @returns {{nodes: Record<string, object>, rootId: string|null}}
 */
export function resumableNodes(tree) {
  const rootId = tree.rootId && tree.nodes[tree.rootId]?.kind === ROOT ? tree.rootId : null;
  const nodes = {};
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.kind !== PASSAGE && !rootId) continue;
    nodes[id] = node.failed && !rootId ? { ...node, failed: false, segments: null } : { ...node };
  }
  return { nodes, rootId };
}

function fallbackTitle(sentences, topics) {
  const first = sentences[0];
  const topic = (Array.isArray(topics) ? topics : []).find((item) =>
    item?.sentences?.includes(first),
  );
  const name = topic ? splitTopicPath(topic.name).at(-1) : '';
  return name || `Sentences ${first}–${sentences.at(-1)}`;
}

/**
 * Build or resume the summary tree of a completed record.
 * @param {object} input
 * @param {object} input.runtime `{signal, log, saveSummaryTree, maxTextChunkChars}`.
 * @param {object} input.record Record with `sentences`, `topics`, and `contentRevision`.
 * @param {Function} input.callLLMWithRetry Shared-limiter completion request.
 * @param {Function|null} [input.decide] Shared-limiter decision request, when configured.
 * @param {string} input.fingerprint Provider identity; a change invalidates the checkpoint.
 * @param {string} [input.rootTitle]
 * @param {boolean} [input.fresh] Ignore a reusable checkpoint.
 * @param {number} [input.workers]
 * @param {number} [input.heartbeatMs] Save interval while requests are in flight; 0 disables.
 * @param {function(): number} [input.now]
 * @returns {Promise<object>} The finished `summary_tree`.
 */
export async function runSummaryTree({
  runtime,
  record,
  callLLMWithRetry,
  decide = null,
  fingerprint,
  rootTitle = 'Article',
  fresh = false,
  workers = SUMMARY_CONCURRENCY,
  heartbeatMs = SUMMARY_TREE_HEARTBEAT_MS,
  now = Date.now,
}) {
  const sentenceTexts = Array.isArray(record?.sentences) ? record.sentences : [];
  if (!sentenceTexts.some((text) => typeof text === 'string' && text.trim())) {
    throw new SummaryTreeError('The record has no sentences to summarize.');
  }
  const maxChars = Number.isFinite(runtime.maxTextChunkChars)
    ? runtime.maxTextChunkChars
    : Infinity;

  // Workers stop at their next request once any of them fails the stage.
  const controller = new AbortController();
  const merged = mergeAbortSignals(runtime.signal, controller.signal);
  const { signal } = merged;
  const llm = createSummaryTreeLlm({ callLLMWithRetry, signal, runtime });
  const judge = createSummaryTreeJudge({ decide, signal, runtime });

  const prior = record.summary_tree;
  const reusable = !fresh && isSummaryTreeReusable(prior, record, fingerprint);
  let nodes;
  let rootId = null;
  if (reusable) {
    ({ nodes, rootId } = resumableNodes(prior));
  } else {
    nodes = {};
    const passageMaxChars = Math.min(PASSAGE_MAX_CHARS, maxChars);
    const passages = buildPassages(sentenceTexts, record.topics, {
      targetChars: Math.min(PASSAGE_TARGET_CHARS, Math.floor(passageMaxChars / 2)),
      minChars: Math.min(PASSAGE_MIN_CHARS, Math.floor(passageMaxChars / 4)),
      maxChars: passageMaxChars,
    });
    for (const sentences of passages) {
      addNode(nodes, PASSAGE, fallbackTitle(sentences, record.topics), [], { sentences });
    }
  }
  const verifier = judge.active ? createClaimVerifier({ judge, nodes, sentenceTexts }) : null;
  const startedAt = reusable && Number.isFinite(prior.startedAt) ? prior.startedAt : now();
  let stage = SUMMARY_TREE_STAGE.PASSAGES;
  let lastSaved = 0;
  let unsaved = false;

  const progress = () => {
    const all = Object.values(nodes);
    if (stage === SUMMARY_TREE_STAGE.PASSAGES) {
      const passages = all.filter((node) => node.kind === PASSAGE);
      return {
        done: passages.filter((node) => node.segments !== null).length,
        total: passages.length,
      };
    }
    if (stage === SUMMARY_TREE_STAGE.TOPICS) {
      return { done: all.filter((node) => node.kind === TOPIC).length, total: 0 };
    }
    const targets = topicIds(nodes);
    return {
      done: targets.filter((id) => nodes[id].segments !== null).length,
      total: targets.length,
    };
  };

  const snapshot = (status, extra = {}) => {
    const all = Object.values(nodes);
    return {
      version: SUMMARY_TREE_VERSION,
      status,
      stage,
      contentRevision: record.contentRevision ?? null,
      fingerprint,
      rootId,
      nodes,
      progress: progress(),
      error: null,
      startedAt,
      updatedAt: now(),
      metrics: {
        passages: all.filter((node) => node.kind === PASSAGE).length,
        failedPassages: all.filter((node) => node.failed).length,
        skippedPassages: all.filter(
          (node) => node.kind === PASSAGE && !node.failed && node.segments?.length === 0,
        ).length,
        topics: all.filter((node) => node.kind === TOPIC).length,
        levels: treeLevels(rootId, nodes),
        llmCalls: llm.metrics.calls,
        llmInvalidAnswers: llm.metrics.invalidAnswers,
        llmFailures: llm.metrics.failures,
        decisionCalls: judge.metrics.calls,
        decisionFailures: judge.metrics.failures,
        decisionsActive: judge.active,
        claimsDropped: verifier?.metrics.dropped ?? 0,
      },
      ...extra,
    };
  };

  // Throttled to once per second; `flush` publishes what the throttle skipped.
  const save = async () => {
    if (now() - lastSaved < SAVE_INTERVAL_MS) {
      unsaved = true;
      return;
    }
    lastSaved = now();
    unsaved = false;
    await runtime.saveSummaryTree(snapshot(SUMMARY_TREE_STATUS.RUNNING));
  };
  const flush = async () => {
    lastSaved = 0;
    await save();
  };
  const enterStage = async (next) => {
    stage = next;
    await flush();
    await runtime.log('summary_tree_stage', { stage: next, ...progress() });
  };

  await runtime.log('summary_tree_start', {
    resumed: reusable,
    passageCount: Object.values(nodes).filter((node) => node.kind === PASSAGE).length,
    decisions: judge.active,
  });
  // Losing ownership (a newer run, a changed record) stops the workers with
  // the save's cancellation error.
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          flush().catch((error) => controller.abort(error));
        }, heartbeatMs)
      : null;
  try {
    await enterStage(SUMMARY_TREE_STAGE.PASSAGES);
    const passageIds = Object.values(nodes)
      .filter((node) => node.kind === PASSAGE)
      .map((node) => node.id);
    await generateSummaries({
      nodes,
      targets: passageIds,
      sentenceTexts,
      llm,
      verifier,
      workers,
      tolerateFailures: true,
      onNodeDone: save,
      controller,
    });
    const relevant = passageIds.filter((id) => nodes[id].segments.length > 0);
    if (!relevant.length) {
      throw new SummaryTreeError(
        passageIds.every((id) => nodes[id].failed)
          ? 'Could not summarize any passage. Retry to resume.'
          : 'No passage had content to summarize.',
      );
    }

    if (!rootId) {
      await enterStage(SUMMARY_TREE_STAGE.TOPICS);
      // Only this coordinator assigns the root; snapshots merely read it.
      // eslint-disable-next-line require-atomic-updates
      rootId = await buildTopics({
        nodes,
        passageIds: relevant,
        rootTitle,
        llm,
        judge,
        workers,
        batchChars: Math.min(TOPIC_BATCH_CHARS, maxChars),
        onProgress: save,
      });
    }

    await enterStage(SUMMARY_TREE_STAGE.SUMMARIES);
    await generateSummaries({
      nodes,
      targets: topicIds(nodes),
      sentenceTexts,
      llm,
      verifier,
      workers,
      onNodeDone: save,
      controller,
    });
    if (!nodes[rootId].segments?.length) {
      throw new SummaryTreeError('Could not produce a supported overview. Retry to resume.');
    }
  } catch (error) {
    const lost = controller.signal.reason;
    if (controller.signal.aborted && isCancellationError(lost, runtime)) throw lost;
    // Keep completed work for the resume; the caller records the failure.
    if (unsaved && !runtime.signal?.aborted) await flush().catch(() => {});
    throw error;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    merged.dispose();
  }

  stage = SUMMARY_TREE_STAGE.DONE;
  const result = snapshot(SUMMARY_TREE_STATUS.DONE);
  await runtime.saveSummaryTree(result);
  await runtime.log('summary_tree_done', { ...result.progress, ...result.metrics });
  return result;
}
