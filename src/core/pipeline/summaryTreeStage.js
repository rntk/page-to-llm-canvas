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
import { createCheckpointer } from './summaryTreeCheckpoint.js';
import { createClaimVerifier, generateSummaries, markFailed } from './summaryTreeGeneration.js';
import { PASSAGE, ROOT, topicIds } from './summaryTreeModel.js';
import { createSummaryTreeJudge, createSummaryTreeLlm } from './summaryTreeRequests.js';
import { TOPIC_BATCH_CHARS, buildTopics, placeTopics } from './summaryTreeTopics.js';
import {
  SUMMARY_TREE_HEARTBEAT_MS,
  SUMMARY_TREE_STAGE,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../shared/runtime/summaryTree.js';

export { SUMMARY_TREE_STATUS, SUMMARY_TREE_VERSION };

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
 * @param {Set<string>} [sourceNodeIds] Strategy seed nodes kept before grouping completes.
 * @returns {{nodes: Record<string, object>, rootId: string|null}}
 */
export function resumableNodes(tree, sourceNodeIds = new Set()) {
  const rootId = tree.rootId && tree.nodes[tree.rootId]?.kind === ROOT ? tree.rootId : null;
  const nodes = {};
  for (const [id, node] of Object.entries(tree.nodes)) {
    if (node.kind !== PASSAGE && !rootId && !sourceNodeIds.has(id)) continue;
    const restored = { failed: false, unplaced: false, ...node };
    nodes[id] = node.failed && !rootId ? { ...restored, failed: false, segments: null } : restored;
  }
  return { nodes, rootId };
}

async function resumeFinishedTree({
  nodes,
  rootId,
  enterStage,
  llm,
  judge,
  workers,
  maxChars,
  save,
  strategy,
}) {
  const unplaced = Object.values(nodes).filter((node) => node.unplaced);
  // Units that could not be summarized stay out of the tree, as in a first build.
  unplaced.filter((node) => !node.segments?.length).forEach((node) => (node.unplaced = false));
  const units = unplaced.filter((node) => node.unplaced).map((node) => node.id);
  if (units.length) {
    await enterStage(SUMMARY_TREE_STAGE.TOPICS);
    await placeTopics({
      nodes,
      rootId,
      unitIds: units,
      llm,
      judge,
      workers,
      batchChars: Math.min(TOPIC_BATCH_CHARS, maxChars),
      onProgress: save,
      sourceKind: strategy.sourceKind,
      isBranch: strategy.isBranch,
    });
  }
}

/**
 * Build or resume a summary tree. What the tree is made of (article passages
 * or project primary topics) comes from the strategy; this stage only drives
 * summarizing, grouping, and checkpointing.
 * @param {object} input
 * @param {object} input.runtime `{signal, log, saveSummaryTree, maxTextChunkChars}`.
 * @param {object} input.strategy Tree strategy, see `summaryTreeStrategy.js`.
 * @param {Function} input.callLLMWithRetry Shared-limiter completion request.
 * @param {Function|null} [input.decide] Shared-limiter decision request, when configured.
 * @param {number} [input.decisionContextWindowTokens] Decision provider context budget.
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
  strategy,
  callLLMWithRetry,
  decide = null,
  decisionContextWindowTokens,
  fingerprint,
  rootTitle = 'Article',
  fresh = false,
  workers = SUMMARY_CONCURRENCY,
  heartbeatMs = SUMMARY_TREE_HEARTBEAT_MS,
  now = Date.now,
}) {
  const sentenceTexts = Array.isArray(strategy.sentences) ? strategy.sentences : [];
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
  const judge = createSummaryTreeJudge({
    decide,
    signal,
    runtime,
    contextWindowTokens: decisionContextWindowTokens,
  });

  const prior = strategy.prior;
  const reusable = !fresh && isSummaryTreeReusable(prior, strategy, fingerprint);
  let nodes;
  let rootId = null;
  if (reusable) {
    ({ nodes, rootId } = resumableNodes(prior, strategy.seedIds()));
  } else {
    nodes = strategy.seedNodes({ maxChars });
  }
  const verifier = judge.active ? createClaimVerifier({ judge, nodes, sentenceTexts }) : null;
  const startedAt = reusable && Number.isFinite(prior.startedAt) ? prior.startedAt : now();
  await runtime.log('summary_tree_start', {
    resumed: reusable,
    passageCount: Object.values(nodes).filter((node) => node.kind === PASSAGE).length,
    decisions: judge.active,
  });
  const checkpointer = createCheckpointer({
    runtime,
    now,
    nodes,
    getRootId: () => rootId,
    strategy,
    fingerprint,
    startedAt,
    llm,
    judge,
    verifier,
    heartbeatMs,
    controller,
  });
  const { save, flush, enterStage } = checkpointer;
  try {
    await enterStage(SUMMARY_TREE_STAGE.PASSAGES);
    // A finished tree extended with new pages carries sources still to summarize.
    const sourceIds = Object.values(nodes)
      .filter((node) => strategy.isSource(node))
      .map((node) => node.id);
    await generateSummaries({
      nodes,
      targets: sourceIds,
      sentenceTexts,
      llm,
      verifier,
      workers,
      onFailure: markFailed,
      onNodeDone: save,
      onAbort: () => controller.abort(),
      sourceOf: strategy.sourceOf,
    });
    const groupIds = strategy.groupIds(nodes);
    const relevant = groupIds.filter((id) => nodes[id].segments?.length > 0);
    if (!relevant.length && !rootId) {
      throw new SummaryTreeError(
        groupIds.every((id) => nodes[id].failed)
          ? 'Could not summarize any passage. Retry to resume.'
          : 'No passage had content to summarize.',
      );
    }

    if (rootId) {
      await resumeFinishedTree({
        nodes,
        rootId,
        enterStage,
        llm,
        judge,
        workers,
        maxChars,
        save,
        strategy,
      });
    } else {
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
        sourceKind: strategy.sourceKind,
        groupSmallRoot: strategy.groupSmallRoot,
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
      onAbort: () => controller.abort(),
      sourceOf: strategy.sourceOf,
    });
    if (!nodes[rootId].segments?.length) {
      throw new SummaryTreeError('Could not produce a supported overview. Retry to resume.');
    }
  } catch (error) {
    const lost = controller.signal.reason;
    if (controller.signal.aborted && isCancellationError(lost, runtime)) throw lost;
    // Keep completed work for the resume; the caller records the failure.
    if (checkpointer.unsaved && !runtime.signal?.aborted) await flush().catch(() => {});
    throw error;
  } finally {
    checkpointer.dispose();
    merged.dispose();
  }

  const result = checkpointer.finish();
  await runtime.saveSummaryTree(result);
  await runtime.log('summary_tree_done', { ...result.progress, ...result.metrics });
  return result;
}
