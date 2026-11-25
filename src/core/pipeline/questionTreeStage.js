// Question tree: splits an article into consecutive sections by the reader
// question each section answers, with a short answer and cited supporting points.

import { mergeAbortSignals } from '../llm/abortSignals.js';
import { parallelMap } from '../llm/concurrency.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { isCancellationError } from './cancellation.js';
import { SUMMARY_CONCURRENCY } from './pipelineConfig.js';
import { QUESTION_CHUNK_CHARS, buildQuestionChunks } from './questionTreeChunks.js';
import { parseQuestionGroups, parseQuestionSections } from './questionTreeParse.js';
import { buildQuestionGroupingPrompt, buildQuestionSectionsPrompt } from './questionTreePrompts.js';
import { createSummaryTreeLlm } from './summaryTreeRequests.js';
import {
  QUESTION_TREE_STAGE,
  QUESTION_TREE_STATUS,
  QUESTION_TREE_VERSION,
} from '../../shared/runtime/questionTree.js';
import { SUMMARY_TREE_HEARTBEAT_MS } from '../../shared/runtime/summaryTree.js';

export { QUESTION_TREE_STATUS, QUESTION_TREE_VERSION };

const SAVE_INTERVAL_MS = 1000;
const MAX_UNGROUPED_QUESTIONS = 7;

/**
 * Raised for an expected question-tree failure with a user-facing message.
 */
export class QuestionTreeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuestionTreeError';
  }
}

/**
 * Whether a saved question tree belongs to this content and request identity.
 * @param {object|null|undefined} tree Saved `question_tree`.
 * @param {object} record
 * @param {string} fingerprint Provider identity of the run.
 * @returns {boolean}
 */
export function isQuestionTreeReusable(tree, record, fingerprint) {
  return (
    tree?.version === QUESTION_TREE_VERSION &&
    typeof record?.contentRevision === 'string' &&
    tree.contentRevision === record.contentRevision &&
    tree.fingerprint === fingerprint &&
    Array.isArray(tree.chunks) &&
    tree.chunks.length > 0
  );
}

function createQuestionCheckpointer({
  runtime,
  now,
  chunks,
  getGroups,
  record,
  fingerprint,
  startedAt,
  llm,
  heartbeatMs,
  controller,
}) {
  let stage = QUESTION_TREE_STAGE.QUESTIONS;
  let lastSaved = 0;
  let unsaved = false;
  const inFlight = new Set();
  let tail = Promise.resolve();

  const counts = (savedChunks, savedGroups) => {
    let failedChunks = 0;
    let doneChunks = 0;
    let questions = 0;
    let points = 0;
    for (const chunk of savedChunks) {
      if (chunk.failed) failedChunks += 1;
      if (Array.isArray(chunk.sections)) {
        if (!chunk.failed) doneChunks += 1;
        questions += chunk.sections.length;
        for (const section of chunk.sections) {
          points += Array.isArray(section.points) ? section.points.length : 0;
        }
      }
    }
    const groups = Array.isArray(savedGroups)
      ? savedGroups.filter((group) => Array.isArray(group.sections) && group.sections.length > 1)
          .length
      : 0;
    return {
      chunks: savedChunks.length,
      failedChunks,
      doneChunks,
      questions,
      groups,
      points,
    };
  };

  const progress = (totals = counts(chunks, getGroups())) => {
    if (stage === QUESTION_TREE_STAGE.QUESTIONS) {
      return { done: totals.doneChunks, total: totals.chunks };
    }
    return { done: 0, total: 0 };
  };

  const snapshot = (status, error = null) => {
    const savedChunks = structuredClone(chunks);
    const savedGroups = structuredClone(getGroups());
    const totals = counts(savedChunks, savedGroups);
    return {
      version: QUESTION_TREE_VERSION,
      backgroundRecovery: true,
      status,
      stage,
      contentRevision: record.contentRevision ?? null,
      fingerprint,
      chunks: savedChunks,
      groups: savedGroups,
      progress: progress(totals),
      error,
      startedAt,
      updatedAt: now(),
      metrics: {
        chunks: totals.chunks,
        failedChunks: totals.failedChunks,
        questions: totals.questions,
        groups: totals.groups,
        points: totals.points,
        llmCalls: llm.metrics.calls,
        llmInvalidAnswers: llm.metrics.invalidAnswers,
        llmFailures: llm.metrics.failures,
      },
    };
  };

  const save = async () => {
    if (now() - lastSaved < SAVE_INTERVAL_MS) {
      unsaved = true;
      return;
    }
    lastSaved = now();
    unsaved = false;
    const tree = snapshot(QUESTION_TREE_STATUS.RUNNING);
    const write = tail.then(() => runtime.saveQuestionTree(tree));
    tail = write.catch(() => {});
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
    await runtime.log('question_tree_stage', { stage: next, ...progress() });
  };

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
    idle: async () => {
      while (inFlight.size) await Promise.allSettled([...inFlight]);
    },
    finish: () => {
      stage = QUESTION_TREE_STAGE.DONE;
      return snapshot(QUESTION_TREE_STATUS.DONE);
    },
    cancel: (error = 'Stopped.') => snapshot(QUESTION_TREE_STATUS.CANCELLED, error),
    dispose: () => {
      if (heartbeat) clearInterval(heartbeat);
    },
  };
}

function buildSentenceMap(sentenceIds, sentenceTexts) {
  const map = {};
  for (const id of sentenceIds) {
    map[String(id)] = String(sentenceTexts[id - 1] ?? '');
  }
  return map;
}

function applyChunkOutcome(chunk, sections) {
  if (sections) {
    chunk.sections = sections;
    chunk.failed = false;
  } else {
    chunk.sections = null;
    chunk.failed = true;
  }
}

async function resolveQuestionGroups({ flat, llm, runtime }) {
  if (flat.length <= MAX_UNGROUPED_QUESTIONS) return [];
  const items = flat.map((section, index) => ({
    id: `Q${index + 1}`,
    question: section.question,
    answer: section.answer,
  }));
  const maxChars = Number.isFinite(runtime.maxTextChunkChars)
    ? runtime.maxTextChunkChars
    : Infinity;
  const payloadChars = JSON.stringify({ questions: items }).length;
  if (payloadChars > maxChars) {
    await runtime.log('question_tree_grouping_skipped', {
      questionCount: flat.length,
      reason: 'payload_too_large',
      payloadChars,
      maxChars,
    });
    return [];
  }
  const grouped = await llm.askDecoded(
    buildQuestionGroupingPrompt(items),
    (raw) => parseQuestionGroups(raw, flat.length),
    LLM_TASK_TYPES.QUESTION_TREE,
  );
  if (grouped) return grouped;
  await runtime.log('question_tree_grouping_skipped', { questionCount: flat.length });
  return [];
}

/**
 * Build or resume the question tree of a completed record.
 * @param {object} input
 * @param {object} input.runtime `{signal, log, saveQuestionTree, maxTextChunkChars}`.
 * @param {object} input.record Saved record.
 * @param {Function} input.callLLMWithRetry Shared-limiter completion request.
 * @param {string} input.fingerprint Provider identity; a change invalidates the checkpoint.
 * @param {boolean} [input.fresh] Ignore a reusable checkpoint.
 * @param {number} [input.workers]
 * @param {number} [input.heartbeatMs] Save interval while requests are in flight; 0 disables.
 * @param {function(): number} [input.now]
 * @returns {Promise<object>} The finished `question_tree`.
 */
export async function runQuestionTree({
  runtime,
  record,
  callLLMWithRetry,
  fingerprint,
  fresh = false,
  workers = SUMMARY_CONCURRENCY,
  heartbeatMs = SUMMARY_TREE_HEARTBEAT_MS,
  now = Date.now,
}) {
  const sentenceTexts = Array.isArray(record?.sentences) ? record.sentences : [];
  if (!sentenceTexts.some((text) => typeof text === 'string' && text.trim())) {
    throw new QuestionTreeError('The record has no sentences to read.');
  }

  const controller = new AbortController();
  const merged = mergeAbortSignals(runtime.signal, controller.signal);
  const { signal } = merged;
  const llm = createSummaryTreeLlm({ callLLMWithRetry, signal, runtime });

  const prior = record?.question_tree;
  const reusable = !fresh && isQuestionTreeReusable(prior, record, fingerprint);
  let chunks;
  let groups = null;
  let startedAt;
  if (reusable) {
    chunks = prior.chunks.map((chunk) =>
      chunk.failed
        ? { ...structuredClone(chunk), failed: false, sections: null }
        : { ...structuredClone(chunk), failed: false },
    );
    const allChunksDone = chunks.every((chunk) => Array.isArray(chunk.sections));
    groups = allChunksDone && Array.isArray(prior.groups) ? structuredClone(prior.groups) : null;
    startedAt = Number.isFinite(prior.startedAt) ? prior.startedAt : now();
  } else {
    const runtimeLimit = Number.isFinite(runtime.maxTextChunkChars)
      ? runtime.maxTextChunkChars
      : Infinity;
    chunks = buildQuestionChunks(sentenceTexts, record?.topics, {
      maxChars: Math.min(QUESTION_CHUNK_CHARS, runtimeLimit),
    }).map((chunk) => ({ ...chunk, sections: null, failed: false }));
    startedAt = now();
  }

  await runtime.log('question_tree_start', {
    resumed: reusable,
    chunkCount: chunks.length,
  });

  const checkpointer = createQuestionCheckpointer({
    runtime,
    now,
    chunks,
    getGroups: () => groups,
    record,
    fingerprint,
    startedAt,
    llm,
    heartbeatMs,
    controller,
  });
  const { save, flush, enterStage } = checkpointer;
  const onAbort = () => controller.abort();
  const setGroups = (nextGroups) => {
    groups = nextGroups;
  };

  try {
    await enterStage(QUESTION_TREE_STAGE.QUESTIONS);
    const pending = chunks.filter((chunk) => !Array.isArray(chunk.sections));
    if (pending.length) {
      await parallelMap(pending, workers, async (chunk) => {
        const prompt = buildQuestionSectionsPrompt({
          firstSentence: chunk.sentences[0],
          lastSentence: chunk.sentences.at(-1),
          sentences: buildSentenceMap(chunk.sentences, sentenceTexts),
        });
        const sections = await llm.askDecoded(
          prompt,
          (raw) => parseQuestionSections(raw, chunk.sentences),
          LLM_TASK_TYPES.QUESTION_TREE,
        );
        applyChunkOutcome(chunk, sections);
        await save();
      });
    }

    const failedCount = chunks.filter((chunk) => chunk.failed).length;
    if (failedCount === chunks.length) {
      throw new QuestionTreeError('Could not find questions in any part. Retry to resume.');
    }
    if (failedCount > 0) {
      throw new QuestionTreeError(
        `${failedCount} of ${chunks.length} parts could not be read. Resume to retry them.`,
      );
    }

    if (groups === null) {
      await enterStage(QUESTION_TREE_STAGE.GROUPING);
      const flat = chunks.flatMap((chunk) => chunk.sections || []);
      setGroups(await resolveQuestionGroups({ flat, llm, runtime }));
    }
  } catch (error) {
    const lost = controller.signal.reason;
    if (controller.signal.aborted && isCancellationError(lost, runtime)) throw lost;
    onAbort();
    await checkpointer.idle();
    if (checkpointer.unsaved) {
      if (runtime.signal?.aborted) {
        await runtime
          .saveQuestionTree(checkpointer.cancel('Stopped.'), { allowAborted: true })
          .catch(() => {});
      } else {
        await flush().catch(() => {});
      }
    }
    throw error;
  } finally {
    checkpointer.dispose();
    merged.dispose();
  }

  await checkpointer.idle();
  const result = checkpointer.finish();
  await runtime.saveQuestionTree(result);
  await runtime.log('question_tree_done', { ...result.progress, ...result.metrics });
  return result;
}
