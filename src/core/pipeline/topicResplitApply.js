// Pure record-level logic for the explicit topic-card Resplit action: checking
// that a requested target still matches the saved topic checkpoint, and
// splicing a resplit result back into that checkpoint. Kept free of storage
// and LLM calls so the request handler and the orchestrator share one
// definition and it can be tested directly.

import {
  canonicalTopicPath,
  joinTopicPath,
  splitTopicPath,
} from '../../shared/runtime/topicPath.js';
import { topicLabelKey } from './topicParser.js';

/**
 * @typedef {object} ResplitTarget
 * @property {string} path Topic path in either spelling.
 * @property {number} startSentence 1-based, inclusive.
 * @property {number} endSentence 1-based, inclusive.
 */

function isWithinPath(candidate, target) {
  const candidateKey = topicLabelKey(splitTopicPath(candidate));
  const targetKey = topicLabelKey(splitTopicPath(target));
  return candidateKey === targetKey || candidateKey.startsWith(`${targetKey}\u0000`);
}

// A path whose summaries depend on the target's sentences: the target, its
// descendants, and its ancestors (which aggregate the target's summaries).
function isOnTargetLine(candidate, target) {
  return isWithinPath(candidate, target) || isWithinPath(target, candidate);
}

function targetSentenceIds({ startSentence, endSentence }) {
  return Array.from(
    { length: endSentence - startSentence + 1 },
    (_, offset) => startSentence + offset,
  );
}

/**
 * Checks a resplit target against the record's saved topic checkpoint.
 * Every sentence in the range must belong to the target topic or one of its
 * descendants, i.e. the target is one contiguous card as the canvas shows it.
 * @param {object} record
 * @param {ResplitTarget} target
 * @returns {string|null} A user-facing error, or null when the target is valid.
 */
export function validateResplitTarget(record, target) {
  const { path, startSentence, endSentence } = target || {};
  if (!Array.isArray(record?.sentences) || !Array.isArray(record?.topics)) {
    return 'The saved topic checkpoint is incomplete. Reprocess the record first.';
  }
  if (typeof path !== 'string' || !splitTopicPath(path).length) return 'missing topic path';
  if (!Number.isInteger(startSentence) || !Number.isInteger(endSentence)) {
    return 'missing topic sentence range';
  }
  if (startSentence < 1 || endSentence < startSentence) return 'invalid topic sentence range';
  if (endSentence > record.sentences.length) {
    return 'topic sentence range is outside the saved checkpoint';
  }
  const canonicalPath = canonicalTopicPath(path);
  const coveredIds = new Set(
    record.topics
      .filter((topic) => isWithinPath(canonicalTopicPath(topic.name), canonicalPath))
      .flatMap((topic) => topic.sentences || []),
  );
  // The card is one maximal run: every sentence covered, and neither
  // neighbour covered, so a run that has since grown around it is rejected.
  if (
    coveredIds.has(startSentence - 1) ||
    coveredIds.has(endSentence + 1) ||
    !targetSentenceIds(target).every((sentenceId) => coveredIds.has(sentenceId))
  ) {
    return 'topic card is stale or does not match the saved topic checkpoint';
  }
  return null;
}

// Canonical names, merged duplicates, sorted sentence ids, ordered by first
// sentence so the saved order follows the article.
function normalizeTopics(entries) {
  const byPath = new Map();
  // Register retained paths first. The parser uses this same segment-level key
  // and keeps the first spelling of each segment within its parent branch.
  const spellings = new Map();
  for (const { name, sentences } of entries) {
    const parts = [];
    for (const part of splitTopicPath(name)) {
      const key = topicLabelKey([...parts, part]);
      if (!spellings.has(key)) spellings.set(key, part);
      parts.push(spellings.get(key));
    }
    const path = joinTopicPath(parts);
    if (!byPath.has(path)) byPath.set(path, new Set());
    for (const sentenceId of sentences || []) byPath.get(path).add(sentenceId);
  }
  return [...byPath]
    .filter(([, sentenceIds]) => sentenceIds.size > 0)
    .map(([name, sentenceIds]) => ({
      name,
      sentences: [...sentenceIds].sort((a, b) => a - b),
    }))
    .sort((a, b) => a.sentences[0] - b.sentences[0] || a.name.localeCompare(b.name));
}

function topicSignature(topics) {
  return JSON.stringify(
    topics
      .map(({ name, sentences }) => [name, sentences])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Replaces the target range of the saved topics with `replacementTopics` and
 * drops only the summary work that covered the replaced sentences. Summary
 * runs are matched by exact sentence list when reused, so trimming the
 * affected entries leaves every untouched run reusable.
 * @param {object} record Record holding a complete topic checkpoint.
 * @param {ResplitTarget} target Validated target.
 * @param {Array<{name: string, sentences: number[]}>} replacementTopics
 * @returns {{topics: object[], topic_summaries: object, topic_summary_index: object,
 *   source_summary_units: object}|null} Null when the topics would not change.
 */
export function applyTopicResplit(record, target, replacementTopics) {
  const canonicalPath = canonicalTopicPath(target.path);
  const selectedIds = new Set(targetSentenceIds(target));
  const touchesSelection = (sentenceIds) =>
    Array.isArray(sentenceIds) && sentenceIds.some((sentenceId) => selectedIds.has(sentenceId));

  const retainedTopics = record.topics.map((topic) =>
    isWithinPath(canonicalTopicPath(topic.name), canonicalPath)
      ? {
          name: topic.name,
          sentences: (topic.sentences || []).filter((sentenceId) => !selectedIds.has(sentenceId)),
        }
      : topic,
  );
  const topics = normalizeTopics([...retainedTopics, ...replacementTopics]);
  if (topicSignature(topics) === topicSignature(normalizeTopics(record.topics))) return null;

  const topic_summaries = {};
  for (const [path, summary] of Object.entries(asObject(record.topic_summaries))) {
    if (!isOnTargetLine(canonicalTopicPath(path), canonicalPath)) {
      topic_summaries[path] = summary;
      continue;
    }
    const runs = Array.isArray(summary?.runs)
      ? summary.runs.filter((run) => !touchesSelection(run?.sentences))
      : [];
    const sourceSentences = (summary?.source_sentences || []).filter(
      (sentenceId) => !selectedIds.has(sentenceId),
    );
    if (runs.length || sourceSentences.length) {
      topic_summaries[path] = { ...summary, runs, source_sentences: sourceSentences };
    }
  }
  // Ancestor membership is unchanged by a scoped resplit. Keep its summaries;
  // the tree planner still verifies exact sentence lists before reusing runs.
  // At the selected level and below, only runs outside the selection stay.
  const topic_summary_index = {};
  for (const [path, entry] of Object.entries(asObject(record.topic_summary_index))) {
    if (!isWithinPath(canonicalTopicPath(path), canonicalPath)) {
      topic_summary_index[path] = entry;
      continue;
    }
    const runs = Array.isArray(entry?.runs)
      ? entry.runs.filter((run) => !touchesSelection(run?.sentences))
      : [];
    if (runs.length) topic_summary_index[path] = { ...entry, runs };
  }
  const source_summary_units = Object.fromEntries(
    Object.entries(asObject(record.source_summary_units)).filter(
      ([, unit]) => !touchesSelection(unit?.run),
    ),
  );
  return { topics, topic_summaries, topic_summary_index, source_summary_units };
}
