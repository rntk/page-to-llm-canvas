// Plan per-run summary reuse without mutating the checkpoint. `error` and
// `forcedEmpty` require a retry; `acceptedFailure` is reused for the current
// Skip resume and finalized as `forcedEmpty` afterward.

import { splitContiguousRuns } from './topicTreeMerge.js';
import { isFailedSummaryRun } from './summaryRunMarkers.js';

/**
 * A single summarization attempt's stored output.
 * @typedef {object} SummaryRun
 * @property {number[]} sentences
 * @property {string} text
 */

/**
 * A saved summary entry keyed by topic name.
 * @typedef {object} PreviousSummaryEntry
 * @property {Array<SummaryRun>} runs
 * @property {boolean} [error]
 * @property {boolean} [forcedEmpty]
 * @property {boolean} [acceptedFailure]
 */

/**
 * A previous summary reused as-is for the resumed run (see planSummaryWork).
 * @typedef {object} ReusedSummaryEntry
 * @property {Array<SummaryRun>} runs
 * @property {number[]} source_sentences
 * @property {boolean} [acceptedFailure]
 */

/**
 * @typedef {object} PlanSummaryWorkResult
 * @property {Record<string, ReusedSummaryEntry>} reused
 * @property {Array<object>} pending Executable per-topic plans.
 * @property {number} reusedCount
 * @property {number} pendingCount
 * @property {number} total
 */

/**
 * @param {Array<{name: string, sentences: number[]}>} topics
 * @param {Record<string, PreviousSummaryEntry>} previousSummaries
 * @returns {PlanSummaryWorkResult}
 */
export function planSummaryWork(topics, previousSummaries = {}) {
  const reused = {};
  const pending = [];
  for (const topic of topics) {
    const prev = previousSummaries[topic.name];
    const plan = planSummaryRuns(topic, prev);
    if (plan.pendingRunIndexes.length === 0) {
      reused[topic.name] = {
        runs: plan.runResults,
        source_sentences: topic.sentences,
        // Copy only this transient marker into the narrowed reuse shape.
        ...(plan.acceptedFailure ? { acceptedFailure: true } : {}),
      };
    } else {
      pending.push({ ...topic, ...plan });
    }
  }
  const total = topics.length;
  const pendingCount = pending.length;
  return {
    reused,
    pending,
    reusedCount: total - pendingCount,
    pendingCount,
    total,
  };
}

const sameRun = (a, b) =>
  !!a &&
  typeof a === 'object' &&
  !Array.isArray(a) &&
  typeof a.text === 'string' &&
  Array.isArray(a.sentences) &&
  a.sentences.length === b.length &&
  a.sentences.every((id, index) => id === b[index]);

const runKey = (sentences) => sentences.join(',');

/**
 * Reuse structurally valid nonempty runs and plan failed or missing runs.
 * Carry accepted failures into the force-finalize tree pass.
 *
 * @param {{name: string, sentences?: number[]}} topic
 * @param {PreviousSummaryEntry|undefined} previous
 * @returns {{runResults: Array<object>, pendingRunIndexes: number[], acceptedFailure: boolean, previousFailure: object|null}}
 */
function planSummaryRuns(topic, previous) {
  const expectedRuns = splitContiguousRuns(topic?.sentences);
  const validPrevious =
    previous &&
    typeof previous === 'object' &&
    !Array.isArray(previous) &&
    Array.isArray(previous.runs);
  const previousByKey = new Map();
  if (validPrevious) {
    for (const run of previous.runs) {
      if (run && Array.isArray(run.sentences)) previousByKey.set(runKey(run.sentences), run);
    }
  }

  const runResults = [];
  const pendingRunIndexes = [];
  let acceptedFailure = false;
  let previousFailure = null;
  for (const [index, expected] of expectedRuns.entries()) {
    const prior = previousByKey.get(runKey(expected));
    if (!sameRun(prior, expected)) {
      runResults.push({ sentences: expected, text: '', error: true });
      pendingRunIndexes.push(index);
      continue;
    }

    if (prior.acceptedFailure === true) {
      runResults.push(prior);
      acceptedFailure = true;
    } else if (isFailedSummaryRun(prior)) {
      runResults.push(prior);
      pendingRunIndexes.push(index);
      previousFailure ||= {
        error_kind: prior.error_kind,
        error_message: prior.error_message,
        error_detail: prior.error_detail,
      };
    } else {
      runResults.push(prior);
    }
  }

  return {
    runResults,
    pendingRunIndexes,
    acceptedFailure,
    // Preserve useful error details while the failed run is being retried.
    previousFailure,
  };
}
