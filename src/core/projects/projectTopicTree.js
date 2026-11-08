// A project tree groups the primary topics already saved for its pages. Global
// row ids are private to this snapshot; every id retains its record and original
// sentence number so overlapping article-local ids can never alias.

import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';
import {
  PASSAGE_MAX_CHARS,
  ROOT,
  TOPIC,
  createPassage,
  createTopic,
  buildPassages,
} from '../pipeline/summaryTreeModel.js';
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

function hashText(text) {
  // Two independent 32-bit hashes keep the revision compact in every checkpoint.
  let first = 2166136261;
  let second = 5381;
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    first = Math.imul(first ^ value, 16777619);
    second = Math.imul(second, 33) ^ value;
  }
  return `${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}`;
}

const recordIdentity = (record) => [
  record.key,
  record.contentRevision,
  record.sourceUrl,
  record.sentences,
  record.topics,
  record.topic_summary_index,
];

/** Content identity of one page; splits and summaries may change without text edits.
 * @param {object} record
 */
export function projectRecordRevision(record) {
  return hashText(JSON.stringify(recordIdentity(record)));
}

/** Stable content identity of a set of pages.
 * @param {object[]} records
 */
export function projectTopicSourceRevision(records) {
  return `project-topics-v1:${hashText(JSON.stringify(records.map(recordIdentity)))}`;
}

/**
 * How the current pages differ from the pages a saved tree was built from.
 * Order and tab titles do not matter, only content.
 * @param {object[]|undefined} saved `tree.records`.
 * @param {object[]} records Current source records.
 * @returns {{added: object[], changed: object[], removed: object[], total: number}}
 */
export function diffProjectRecords(saved, records) {
  const before = new Map((Array.isArray(saved) ? saved : []).map((item) => [item.key, item]));
  const added = [];
  const changed = [];
  for (const record of records) {
    const prior = before.get(record.key);
    before.delete(record.key);
    if (!prior) added.push(record);
    else if (
      prior.revision
        ? prior.revision !== projectRecordRevision(record)
        : prior.contentRevision !== (record.contentRevision || null)
    ) {
      changed.push(record);
    }
  }
  const removed = [...before.values()];
  return { added, changed, removed, total: added.length + changed.length + removed.length };
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
 * @param {{sentences: string[], sources: object, records: object[]}} [options.base]
 *   Rows already in a saved tree; new pages append after them so existing ids stay valid.
 */
export function buildProjectTopicSeed(records, { maxChars = PASSAGE_MAX_CHARS, base = null } = {}) {
  const sentences = [...(base?.sentences || [])];
  const sources = { ...base?.sources };
  const nodes = {};
  const sourceTopicIds = [];
  const sourceRecords = [...(base?.records || [])];
  for (const record of records) {
    const offset = sentences.length;
    const title = record.title || record.sourceTitle || record.sourceUrl || 'Saved page';
    sourceRecords.push({
      key: record.key,
      title,
      url: record.sourceUrl || '',
      contentRevision: record.contentRevision || null,
      revision: projectRecordRevision(record),
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
      const origin = {
        recordKey: record.key,
        topicName: topic.name,
        sourceTitle: title,
        sourceUrl: record.sourceUrl || '',
      };
      const children = chunks.map((ids) => {
        const id = createPassage(
          nodes,
          topicTitle,
          ids.map((local) => offset + local),
          origin,
        );
        if (segments) nodes[id].segments = segments;
        return id;
      });
      const id =
        children.length === 1
          ? children[0]
          : createTopic(nodes, topicTitle, children, {
              ...origin,
              path: splitTopicPath(topic.name),
            });
      sourceTopicIds.push(id);
    }
  }
  return { nodes, sourceTopicIds, sentences, sources, records: sourceRecords };
}

/**
 * Whether a node is one of the grouping topics the merge created above page topics.
 * @param {object} node
 */
export const isGroupNode = (node) =>
  (node?.kind === TOPIC || node?.kind === ROOT) && !node.recordKey;

/**
 * Edit a finished tree in place of rebuilding it: drop the nodes of removed or
 * changed pages, and append the new pages as unplaced units for the stage to
 * summarize and attach. Branches that lost or will gain children lose their
 * summary so only they are rewritten. Unchanged branches keep theirs.
 * @param {object} prior Saved project tree with a root.
 * @param {object[]} records Current source records.
 * @param {object} options
 * @param {string} options.contentRevision Revision of the current pages.
 * @param {number} [options.maxChars]
 * @returns {{tree: object, seed: object, changes: object}|null} Null when the tree cannot be extended.
 */
export function prepareIncrementalProjectTree(prior, records, { contentRevision, maxChars } = {}) {
  const rootId = prior?.rootId;
  if (
    !rootId ||
    prior.nodes?.[rootId]?.kind !== ROOT ||
    !Array.isArray(prior.records) ||
    !Array.isArray(prior.sentences) ||
    !prior.sources
  ) {
    return null;
  }
  const changes = diffProjectRecords(prior.records, records);
  const dropped = new Set([...changes.removed, ...changes.changed].map((item) => item.key));
  const nodes = structuredClone(prior.nodes);
  const touched = new Set();
  for (const node of Object.values(nodes)) {
    if (node.recordKey && dropped.has(node.recordKey)) delete nodes[node.id];
  }
  for (const node of Object.values(nodes)) {
    const children = node.children.filter((id) => nodes[id]);
    if (children.length !== node.children.length) touched.add(node.id);
    node.children = children;
  }
  // A grouping branch left without children disappears with them.
  for (let pruned = true; pruned; ) {
    pruned = false;
    for (const node of Object.values(nodes)) {
      if (node.kind !== TOPIC || node.recordKey || node.children.length) continue;
      delete nodes[node.id];
      for (const parent of Object.values(nodes)) {
        if (!parent.children.includes(node.id)) continue;
        parent.children = parent.children.filter((id) => id !== node.id);
        touched.add(parent.id);
      }
      pruned = true;
    }
  }
  if (!nodes[rootId].children.length) return null;

  // Ids of earlier additions stay in the tree, so the next prefix is derived from them.
  const increments =
    1 + Math.max(0, ...Object.keys(nodes).map((id) => Number(/^i(\d+)_/.exec(id)?.[1] ?? 0)));
  const seed = buildProjectTopicSeed([...changes.changed, ...changes.added], {
    maxChars,
    base: {
      sentences: prior.sentences,
      sources: prior.sources,
      records: prior.records.filter((item) => !dropped.has(item.key)),
    },
  });
  const rename = (id) => `i${increments}_${id}`;
  for (const node of Object.values(seed.nodes)) {
    nodes[rename(node.id)] = {
      ...node,
      id: rename(node.id),
      children: node.children.map(rename),
      unplaced: seed.sourceTopicIds.includes(node.id),
    };
  }
  seed.sourceTopicIds.forEach((id) => touched.add(rename(id)));
  seed.nodes = Object.fromEntries(
    Object.entries(nodes).filter(([id]) => id.startsWith(`i${increments}_`)),
  );
  seed.sourceTopicIds = seed.sourceTopicIds.map(rename);

  // Refresh membership bottom-up; a branch whose descendants changed is rewritten.
  const refresh = (id) => {
    const node = nodes[id];
    if (!isGroupNode(node)) return touched.has(id);
    const dirty = node.children.map(refresh).some(Boolean) || touched.has(id);
    if (dirty) {
      node.segments = null;
      node.sentences = [...new Set(node.children.flatMap((child) => nodes[child].sentences))].sort(
        (a, b) => a - b,
      );
    }
    return dirty;
  };
  refresh(rootId);
  return {
    tree: { ...prior, nodes, contentRevision, sourceRevision: contentRevision },
    seed,
    changes,
  };
}
