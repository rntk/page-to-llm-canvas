import { PASSAGE, ROOT, TOPIC, treeLevels } from './summaryTreeModel.js';
import {
  SUMMARY_TREE_STAGE,
  SUMMARY_TREE_STATUS,
  SUMMARY_TREE_VERSION,
} from '../../shared/runtime/summaryTree.js';
const SAVE_INTERVAL_MS = 1000;

// Owns checkpoint state and its timer; the coordinator supplies the current root.
export function createCheckpointer({
  runtime,
  now,
  nodes,
  getRootId,
  strategy,
  fingerprint,
  startedAt,
  llm,
  judge,
  verifier,
  heartbeatMs,
  controller,
}) {
  let stage = SUMMARY_TREE_STAGE.PASSAGES;
  let lastSaved = 0;
  let unsaved = false;
  const inFlight = new Set();

  const counts = () => {
    const totals = {
      passages: 0,
      failedPassages: 0,
      skippedPassages: 0,
      topics: 0,
      passageDone: 0,
      summaryDone: 0,
      summaryTotal: 0,
    };
    for (const node of Object.values(nodes)) {
      if (node.failed) totals.failedPassages++;
      if (node.kind === PASSAGE) {
        totals.passages++;
        if (node.segments !== null) totals.passageDone++;
        if (!node.failed && node.segments?.length === 0) totals.skippedPassages++;
      }
      if (node.kind === TOPIC) totals.topics++;
      if (node.kind === TOPIC || node.kind === ROOT) {
        totals.summaryTotal++;
        if (node.segments !== null) totals.summaryDone++;
      }
    }
    return totals;
  };
  const progress = (totals = counts()) => {
    if (stage === SUMMARY_TREE_STAGE.PASSAGES)
      return { done: totals.passageDone, total: totals.passages };
    if (stage === SUMMARY_TREE_STAGE.TOPICS) return { done: totals.topics, total: 0 };
    return { done: totals.summaryDone, total: totals.summaryTotal };
  };
  const snapshot = (status, extra = {}) => {
    const totals = counts();
    const rootId = getRootId();
    return {
      version: SUMMARY_TREE_VERSION,
      backgroundRecovery: true,
      status,
      stage,
      contentRevision: strategy.contentRevision ?? null,
      fingerprint,
      rootId,
      nodes,
      progress: progress(totals),
      error: null,
      startedAt,
      updatedAt: now(),
      metrics: {
        passages: totals.passages,
        failedPassages: totals.failedPassages,
        skippedPassages: totals.skippedPassages,
        topics: totals.topics,
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
    const write = runtime.saveSummaryTree(snapshot(SUMMARY_TREE_STATUS.RUNNING));
    inFlight.add(write);
    try {
      await write;
    } finally {
      inFlight.delete(write);
    }
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

  // Losing ownership (a newer run, a changed record) stops the workers with
  // the save's cancellation error.
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          flush().catch((error) => controller.abort(error));
        }, heartbeatMs)
      : null;
  return {
    save,
    flush,
    enterStage,
    get unsaved() {
      return unsaved;
    },
    // Settles once no `running` save (worker or heartbeat) is still being written.
    idle: async () => {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    finish: () => {
      stage = SUMMARY_TREE_STAGE.DONE;
      return snapshot(SUMMARY_TREE_STATUS.DONE);
    },
    dispose: () => {
      if (heartbeat) clearInterval(heartbeat);
    },
  };
}
