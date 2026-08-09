// Pure pending-work detection for the per-topic summary stage.
//
// Given the topic list and the summaries carried over from a resumed run, decide
// which topics can reuse their stored summary and which still need an LLM call.
// A previous summary is reusable only when it structurally matches the current
// topic's runs and carries neither `error: true` nor `forcedEmpty: true`.
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
 * @property {Array<object>} pending
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
    if (isReusableSummaryEntry(topic, prev)) {
      reused[topic.name] = {
        runs: prev.runs,
        source_sentences: topic.sentences,
        // Copied field by field on purpose: the narrowed shape is what keeps
        // stale error/marker fields out of the resumed run, so only this one
        // transient marker is carried over explicitly.
        ...(prev.acceptedFailure ? { acceptedFailure: true } : {}),
      };
    } else {
      pending.push(topic);
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

/**
 * A checkpoint entry is reusable only when its runs still cover the current
 * topic's source exactly. The topic list is authoritative: accepting an empty
 * object, an empty run list for a non-empty topic, or arbitrary run ids can
 * otherwise let a damaged/imported checkpoint finalize as complete without
 * generating any summary output.
 *
 * @param {{sentences?: number[]}} topic
 * @param {PreviousSummaryEntry} previous
 * @returns {boolean}
 */
function isReusableSummaryEntry(topic, previous) {
  if (
    !previous ||
    typeof previous !== 'object' ||
    Array.isArray(previous) ||
    previous.error ||
    previous.forcedEmpty ||
    !Array.isArray(topic?.sentences) ||
    !Array.isArray(previous.runs)
  ) {
    return false;
  }

  // Use the same normalization as summary generation. Checkpoints can be
  // imported, so topic sentence ids are not guaranteed to be pre-sorted or
  // de-duplicated even though newly generated topics currently are.
  const expectedRuns = splitContiguousRuns(topic.sentences);
  if (previous.runs.length !== expectedRuns.length) return false;

  return previous.runs.every((run, index) => {
    const expected = expectedRuns[index];
    return (
      !!run &&
      typeof run === 'object' &&
      !Array.isArray(run) &&
      typeof run.text === 'string' &&
      Array.isArray(run.sentences) &&
      run.sentences.length === expected.length &&
      run.sentences.every((sentenceId, sentenceIndex) => sentenceId === expected[sentenceIndex])
    );
  });
}
