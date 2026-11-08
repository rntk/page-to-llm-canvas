// A project tree groups the primary topics already saved for its pages. Global
// row ids are private to this snapshot; every id retains its record and original
// sentence number so overlapping article-local ids can never alias.

import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import { PASSAGE, TOPIC, addNode, buildPassages } from '../pipeline/summaryTreeModel.js';
import { splitTopicPath } from '../../shared/runtime/topicPath.js';

/** Whether this saved record has a completed, usable primary topic split.
 * @param {object} record
 */
export function hasProjectTopicSource(record) {
  if (record?.status !== PIPELINE_STATUS.DONE || !record.key) return false;
  if (!Array.isArray(record.sentences) || !Array.isArray(record.topics)) return false;
  return (
    record.topics.length > 0 &&
    record.topics.every(
      (topic) =>
        typeof topic?.name === 'string' &&
        topic.name.trim() &&
        Array.isArray(topic.sentences) &&
        topic.sentences.every(
          (id) => Number.isInteger(id) && id > 0 && id <= record.sentences.length,
        ),
    ) &&
    record.topics.some((topic) =>
      topic.sentences.some(
        (id) => typeof record.sentences[id - 1] === 'string' && record.sentences[id - 1].trim(),
      ),
    )
  );
}

/** Stable content identity includes splits and summaries, which may change without text edits.
 * @param {object[]} records
 */
export function projectTopicSourceRevision(records) {
  const text = JSON.stringify(
    records.map((record) => [
      record.key,
      record.contentRevision,
      record.sourceUrl,
      record.sentences,
      record.topics,
      record.topic_summary_index,
    ]),
  );
  // Two independent 32-bit hashes keep the revision compact in every checkpoint.
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    first = Math.imul(first ^ value, 16777619);
    second = Math.imul(second, 33) ^ value;
  }
  return `project-topics-v1:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

function savedSegments(record, topic, offset) {
  const entry = record.topic_summary_index?.[topic.name];
  const runs = entry?.runs;
  if (!Array.isArray(runs)) return null;
  const allowed = new Set(topic.sentences);
  const segments = [];
  for (const run of runs) {
    if (typeof run?.text !== 'string' || !run.text.trim()) continue;
    if (
      !Array.isArray(run.sentences) ||
      !run.sentences.length ||
      !run.sentences.every((id) => allowed.has(id))
    )
      return null;
    segments.push({
      text: segments.length ? ` ${run.text.trim()}` : run.text.trim(),
      sources: [...new Set(run.sentences)].map((id) => ({
        kind: 'rows',
        first: offset + id,
        last: offset + id,
      })),
    });
  }
  return segments.length ? segments : null;
}

/**
 * Build summary-tree evidence nodes without splitting across primary topics.
 * Large topics lacking saved summaries get bounded passages under their own
 * primary topic node; the grouping model receives that topic as one input.
 * @param {object[]} records
 * @param {object} [options]
 */
export function buildProjectTopicSeed(records, { maxChars = 3000 } = {}) {
  const sentences = [];
  const sources = {};
  const nodes = {};
  const sourceTopicIds = [];
  const sourceRecords = [];
  for (const record of records) {
    const offset = sentences.length;
    const title = record.title || record.sourceTitle || record.sourceUrl || 'Saved page';
    sourceRecords.push({
      key: record.key,
      title,
      url: record.sourceUrl || '',
      contentRevision: record.contentRevision || null,
    });
    record.sentences.forEach((text, index) => {
      sentences.push(text);
      sources[offset + index + 1] = {
        recordKey: record.key,
        sentenceId: index + 1,
        title,
        url: record.sourceUrl || '',
      };
    });
    for (const topic of record.topics) {
      const localIds = [...new Set(topic.sentences)]
        .sort((a, b) => a - b)
        .filter(
          (id) => typeof record.sentences[id - 1] === 'string' && record.sentences[id - 1].trim(),
        );
      if (!localIds.length) continue;
      const topicTitle = splitTopicPath(topic.name).at(-1) || topic.name;
      const segments = savedSegments(record, topic, offset);
      // Use a dense local array only to size chunks. All persisted row ids map
      // back to the original topic's (possibly noncontiguous) source sentences.
      const chunks = segments
        ? [localIds]
        : buildPassages(
            localIds.map((id) => record.sentences[id - 1]),
            [],
            { targetChars: Math.min(1500, maxChars), minChars: 0, maxChars },
          ).map((ids) => ids.map((id) => localIds[id - 1]));
      const children = chunks.map((ids) => {
        const id = addNode(nodes, PASSAGE, topicTitle, [], {
          sentences: ids.map((local) => offset + local),
        });
        Object.assign(nodes[id], {
          recordKey: record.key,
          topicName: topic.name,
          sourceTitle: title,
          sourceUrl: record.sourceUrl || '',
        });
        if (segments) nodes[id].segments = segments;
        return id;
      });
      const id =
        children.length === 1
          ? children[0]
          : addNode(nodes, TOPIC, topicTitle, children, { path: splitTopicPath(topic.name) });
      Object.assign(nodes[id], {
        recordKey: record.key,
        topicName: topic.name,
        sourceTitle: title,
        sourceUrl: record.sourceUrl || '',
      });
      sourceTopicIds.push(id);
    }
  }
  return { nodes, sourceTopicIds, sentences, sources, records: sourceRecords };
}
