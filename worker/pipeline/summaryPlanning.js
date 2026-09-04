// Pure pending-work detection for the per-topic summary stage.
//
// Given the topic list and the summaries carried over from a resumed run, decide
// which runs can be reused and which still need an LLM call. Pending topics are
// returned as executable per-run plans; the checkpoint unit is a run.
// `error` is the in-flight retry marker: a leaf whose LLM call failed is
// stored with `error: true` so a resumed run re-queries it. `forcedEmpty` is
// its finalized counterpart: the user chose "skip", so the run completed with
// an empty summary the user may still want re-attempted later. A third marker,
// `acceptedFailure: true`, is written by the "skip" handler in place of the
// error fields it strips; it is deliberately NOT part of the reuse condition
// (skip means "accept this leaf, don't re-query it"), but it is carried onto
// the reused entry so the force-finalize pass downstream can still scope
// ancestor summaries around the accepted failure and stamp it `forcedEmpty`.
//
// This function performs no I/O and mutates nothing; the orchestrator owns the
// resulting state mutation and logging.

import { splitContiguousRuns } from './topicTreeMerge.js';
import { isFailedSummaryRun } from './summaryRunMarkers.js';

/**
 * A single summarization attempt's stored output.
 * @typedef {object} SummaryRun
 * @property {number[]} sentences
 * @property {string} text
 */

/**
 * An entry from a resumed run's carried-over summaries, keyed by topic name.
 * See the module comment above for what `error`, `forcedEmpty`, and
 * `acceptedFailure` each mean.
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
        // Copied field by field on purpose: the narrowed shape is what keeps
        // stale error/marker fields out of the resumed run, so only this one
        // transient marker is carried over explicitly.
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
 * Plans each expected run independently. Structurally valid non-empty runs are
 * retained; only failed/missing runs become pending. `acceptedFailure` is
 * intentionally reusable and is carried as a topic marker for the
 * force-finalize tree pass.
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
