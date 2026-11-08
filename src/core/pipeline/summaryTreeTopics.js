// Top-down topic taxonomy over brief passage summaries. Only the short digests
// are sent, so grouping a long article costs a few small requests: the
// digests are split recursively into distinct sub-topics, one level more
// specific each time, until a topic holds few passages. Summaries are written
// afterwards, bottom-up, along the resulting structure.

import { createLimiter } from '../llm/concurrency.js';
import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { ROOT, TOPIC, addNode, summaryText } from './summaryTreeModel.js';
import {
  MAX_BRANCHES,
  NO,
  buildTopicGroupingPrompt,
  buildTopicTitlesPrompt,
  topicChoiceQuestion,
  topicFitsQuestion,
} from './summaryTreePrompts.js';
import { chosenOption, extractObject, yesProbability } from './summaryTreeRequests.js';
import { cleanTitle } from './summaryTreeGeneration.js';

export const LEAF_MAX_PASSAGES = 4; // a topic with at most this many passages is not split further
export const MAX_DEPTH = 3; // topic levels between the root and the passages
export const OTHER_TITLE = 'Other';
const MIN_COVERAGE = 0.75; // share of a batch an answer must assign
const DIGEST_CHARS = 320;
export const TOPIC_BATCH_CHARS = 20000;
const DESCRIPTION_CHARS = 240;
const ASSIGN_PASSAGES = 20; // passages per decision request (two questions each)

/**
 * One-line digest of a summarized passage.
 * @param {Record<string, object>} nodes
 * @param {string} id
 */
export function digest(nodes, id) {
  const node = nodes[id];
  const text = summaryText(node);
  const title = node.title.trim();
  const line = title && !text.includes(title) ? `${title} — ${text}` : text || title;
  return line.slice(0, DIGEST_CHARS);
}

function digestBatches(nodes, ids, batchChars) {
  const batches = [];
  let size = 0;
  for (const id of ids) {
    const chars = digest(nodes, id).length + 8;
    if (!batches.length || size + chars > batchChars) {
      batches.push([]);
      size = 0;
    }
    batches.at(-1).push(id);
    size += chars;
  }
  return batches;
}

/**
 * Validated grouping answer: known ids once each, bounded new titles, enough coverage.
 * @param {string} raw
 * @param {Map<string, string>} local Label -> node id.
 * @param {string[]} existing Titles found in earlier batches.
 * @param {number} maxNew
 * @returns {Map<string, string[]>|null} Title -> node ids, in answer order.
 */
export function decodeAssignment(raw, local, existing, maxNew) {
  const entries = extractObject(raw)?.topics;
  if (!Array.isArray(entries)) return null;
  const canonical = new Map(existing.map((title) => [title.toLowerCase(), title]));
  const topics = new Map();
  const seen = new Set();
  for (const entry of entries) {
    let title = cleanTitle(entry?.title);
    const members = entry?.passages;
    if (!title || !Array.isArray(members)) return null;
    title = canonical.get(title.toLowerCase()) ?? title;
    canonical.set(title.toLowerCase(), title);
    for (const label of members) {
      if (typeof label !== 'string' || !local.has(label) || seen.has(label)) return null;
      seen.add(label);
      if (!topics.has(title)) topics.set(title, []);
      topics.get(title).push(local.get(label));
    }
  }
  const added = [...topics.keys()].filter((title) => !existing.includes(title)).length;
  if (added > maxNew || seen.size < MIN_COVERAGE * local.size) return null;
  return topics;
}

/**
 * Validated proposal: distinct titles with descriptions (one is allowed for projects).
 * @param {string} raw
 * @param {boolean} [allowSingleGroup] Project inputs may share one subject.
 * @returns {Record<string, string>|null}
 */
export function decodeTitles(raw, allowSingleGroup = false) {
  const entries = extractObject(raw)?.topics;
  if (!Array.isArray(entries)) return null;
  const topics = {};
  const seen = new Set([OTHER_TITLE.toLowerCase()]);
  for (const entry of entries) {
    const title = cleanTitle(entry?.title);
    if (!title) return null;
    if (seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const description = String(entry?.description || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, DESCRIPTION_CHARS);
    topics[title] = description || title;
  }
  const count = Object.keys(topics).length;
  return count >= (allowSingleGroup ? 1 : 2) && count <= MAX_BRANCHES ? topics : null;
}

// Evenly spread digests that fit one proposal prompt.
function sample(ids, nodes, batchChars) {
  const total = ids.reduce((sum, id) => sum + digest(nodes, id).length + 8, 0);
  const step = Math.max(1, total / batchChars);
  const picked = Array.from(
    { length: Math.floor(ids.length / step) },
    (_, i) => ids[Math.floor(i * step)],
  );
  return picked.length ? picked : ids.slice(0, 1);
}

/**
 * Sub-topics largest first, "Other" last, members in article order; null
 * when no real split was found.
 * @param {Map<string, string[]>} topics
 * @param {string[]} leftover
 * @param {string[]} ids
 * @param {boolean} [allowSingleGroup] A project can merge all inputs under one shared topic.
 * @returns {Array<[string, string[]]>|null}
 */
export function orderGroups(topics, leftover, ids, allowSingleGroup = false) {
  const groups = [...topics].filter(([, members]) => members.length);
  const other = [...(groups.find(([title]) => title === OTHER_TITLE)?.[1] || []), ...leftover];
  const named = groups
    .filter(([title]) => title !== OTHER_TITLE)
    .sort((a, b) => b[1].length - a[1].length);
  if (other.length) named.push([OTHER_TITLE, other]);
  if (named.length < (allowSingleGroup ? 1 : 2)) return null;
  const order = new Map(ids.map((id, index) => [id, index]));
  return named.map(([title, members]) => [
    title,
    [...members].sort((a, b) => order.get(a) - order.get(b)),
  ]);
}

/**
 * The judge assigns each node to one of the proposed sub-topics or to none.
 * @param {object} input
 * @param {{askMany: Function}} input.judge
 * @param {Record<string, object>} input.nodes
 * @param {string[]} input.ids Summarized nodes to assign.
 * @param {string} input.path Parent topic path.
 * @param {Record<string, string>} input.proposed Sub-topic title -> description.
 * @returns {Promise<{topics: Map<string, string[]>, leftover: string[]}|null>} Null when any answer is missing.
 */
async function judgeAssign({ judge, nodes, ids, path, proposed }) {
  const titles = Object.keys(proposed);
  const state = { path, topics: proposed };
  const requests = [];
  for (let start = 0; start < ids.length; start += ASSIGN_PASSAGES) {
    const questions = {};
    ids.slice(start, start + ASSIGN_PASSAGES).forEach((id, index) => {
      const text = digest(nodes, id);
      questions[`fits_${index}`] = topicFitsQuestion(text);
      questions[`topic_${index}`] = topicChoiceQuestion(text, path, proposed);
    });
    requests.push([state, questions]);
  }
  const answers = await judge.askMany(requests);
  if (answers.some((item) => !item)) return null;
  const topics = new Map();
  const leftover = [];
  ids.forEach((id, position) => {
    const item = answers[Math.floor(position / ASSIGN_PASSAGES)];
    const index = position % ASSIGN_PASSAGES;
    const fits = yesProbability(item, `fits_${index}`);
    const title = fits !== null && fits < NO ? null : chosenOption(item, `topic_${index}`, titles);
    if (!title) leftover.push(id);
    else {
      if (!topics.has(title)) topics.set(title, []);
      topics.get(title).push(id);
    }
  });
  return { topics, leftover };
}

/**
 * Grow topic nodes above summarized passages.
 * @param {object} input
 * @param {Record<string, object>} input.nodes Mutated: topic and root nodes are added.
 * @param {string[]} input.passageIds Summarized passages, in article order.
 * @param {string} input.rootTitle
 * @param {{ask: Function}} input.llm
 * @param {object} [input.judge] Assigns passages with typed questions while active.
 * @param {number} [input.workers]
 * @param {number} [input.batchChars] Digest characters per request.
 * @param {function(): Promise<void>} [input.onProgress]
 * @param {boolean} [input.groupSmallRoot] Group small project source sets at the root.
 * @returns {Promise<string>} Root node id.
 */
export async function buildTopics({
  nodes,
  passageIds,
  rootTitle,
  llm,
  judge = null,
  workers = 4,
  batchChars = TOPIC_BATCH_CHARS,
  onProgress = async () => {},
  groupSmallRoot = false,
}) {
  const ask = (prompt, decode) => {
    let result = null;
    return llm
      .ask(
        prompt,
        (raw) => {
          result = decode(raw);
          return result !== null;
        },
        LLM_TASK_TYPES.SUMMARY_TREE_TOPICS,
      )
      .then((accepted) => (accepted ? result : null));
  };

  const propose = (ids, path) =>
    ask(
      buildTopicTitlesPrompt({
        ...(groupSmallRoot ? { source_kind: 'project_primary_topics' } : {}),
        path: path.join(' › '),
        passages: sample(ids, nodes, batchChars).map((id) => digest(nodes, id)),
      }),
      (raw) => decodeTitles(raw, groupSmallRoot && path.length === 0),
    );

  // The LLM proposes titles once; the judge assigns every passage. Null -> LLM fallback.
  async function splitJudged(ids, path) {
    const proposed = await propose(ids, path);
    if (!proposed || !judge?.active) return null;
    return judgeAssign({ judge, nodes, ids, path: path.join(' › '), proposed });
  }

  async function splitLlm(ids, path) {
    const topics = new Map();
    const leftover = [];
    for (const batch of digestBatches(nodes, ids, batchChars)) {
      const existing = [...topics.keys()];
      const local = new Map(batch.map((id, index) => [`P${index + 1}`, id]));
      const maxNew = existing.length ? Math.max(0, MAX_BRANCHES - existing.length) : MAX_BRANCHES;
      const assignment = await ask(
        buildTopicGroupingPrompt({
          ...(groupSmallRoot ? { source_kind: 'project_primary_topics' } : {}),
          path: path.join(' › '),
          existing_topics: existing,
          max_new_topics: maxNew,
          passages: [...local].map(([id, nodeId]) => ({ id, summary: digest(nodes, nodeId) })),
        }),
        (raw) => decodeAssignment(raw, local, existing, maxNew),
      );
      const assigned = new Set();
      for (const [title, members] of assignment || []) {
        if (!topics.has(title)) topics.set(title, []);
        topics.get(title).push(...members);
        members.forEach((id) => assigned.add(id));
      }
      leftover.push(...batch.filter((id) => !assigned.has(id)));
    }
    return { topics, leftover };
  }

  async function split(ids, path) {
    const judged = judge?.active ? await splitJudged(ids, path) : null;
    const { topics, leftover } = judged ?? (await splitLlm(ids, path));
    return orderGroups(topics, leftover, ids, groupSmallRoot && path.length === 0);
  }

  // Independent splits run concurrently; nodes are assembled afterwards in a stable order.
  const limit = createLimiter(workers);
  const splits = new Map();
  const needsSplit = (ids, depth) =>
    depth < MAX_DEPTH &&
    (ids.length > LEAF_MAX_PASSAGES || (groupSmallRoot && depth === 0 && ids.length > 1));
  const plan = async (ids, path, depth) => {
    if (!needsSplit(ids, depth)) return;
    const groups = await limit(() => split(ids, path));
    splits.set(ids.join(','), groups);
    await onProgress();
    if (groups?.length === 1) return;
    await Promise.all(
      (groups || []).map(([title, members]) => plan(members, [...path, title], depth + 1)),
    );
  };
  await plan(passageIds, [], 0);

  const grow = (ids, path, depth) => {
    const groups = needsSplit(ids, depth) ? splits.get(ids.join(',')) : null;
    if (!groups) return ids;
    return groups.map(([title, members]) => {
      const subPath = [...path, title];
      return addNode(
        nodes,
        TOPIC,
        title,
        groups.length === 1 ? members : grow(members, subPath, depth + 1),
        { path: subPath },
      );
    });
  };
  return addNode(nodes, ROOT, rootTitle, grow(passageIds, [], 0));
}

/**
 * Attach new, summarized units to a finished tree. Each unit descends from the
 * root through the grouping branch it fits best and joins the first level where
 * no branch fits. Every branch on its way loses its summary so it is rewritten.
 * Units are attached as soon as they settle, so a saved snapshot is always whole.
 * @param {object} input
 * @param {Record<string, object>} input.nodes Mutated.
 * @param {string} input.rootId
 * @param {string[]} input.unitIds Summarized units flagged `unplaced`.
 * @param {{ask: Function}} input.llm
 * @param {object} [input.judge]
 * @param {number} [input.workers]
 * @param {number} [input.batchChars]
 * @param {function(): Promise<void>} [input.onProgress]
 */
export async function placeTopics({
  nodes,
  rootId,
  unitIds,
  llm,
  judge = null,
  workers = 4,
  batchChars = TOPIC_BATCH_CHARS,
  onProgress = async () => {},
}) {
  const limit = createLimiter(workers);
  const isBranch = (id) => !nodes[id].recordKey && nodes[id].kind === TOPIC;
  const trail = new Map(unitIds.map((id) => [id, [rootId]]));

  const attach = (id) => {
    const path = trail.get(id);
    const parent = nodes[path.at(-1)];
    parent.children.push(id);
    for (const ancestor of path) {
      const node = nodes[ancestor];
      node.segments = null;
      node.sentences = [...new Set([...node.sentences, ...nodes[id].sentences])].sort(
        (a, b) => a - b,
      );
    }
    delete nodes[id].unplaced;
  };

  // The branch each unit joins, or null when none fits; unanswered units stay at this level.
  async function choose(ids, parentId, branches) {
    const titles = new Map();
    for (const branchId of branches) {
      const title = nodes[branchId].title;
      if (!titles.has(title)) titles.set(title, branchId);
    }
    const path = nodes[parentId].path?.join(' › ') || nodes[parentId].title;
    const choice = new Map();
    const proposed = Object.fromEntries(
      [...titles].map(([title, branchId]) => [
        title,
        summaryText(nodes[branchId]).slice(0, DESCRIPTION_CHARS) || title,
      ]),
    );
    const judged = judge?.active ? await judgeAssign({ judge, nodes, ids, path, proposed }) : null;
    if (judged) {
      for (const [title, members] of judged.topics) {
        members.forEach((id) => choice.set(id, titles.get(title)));
      }
      return choice;
    }
    for (const batch of digestBatches(nodes, ids, batchChars)) {
      const existing = [...titles.keys()];
      const local = new Map(batch.map((id, index) => [`P${index + 1}`, id]));
      // One new title is allowed to mean that no existing branch fits.
      let decoded = null;
      const accepted = await llm.ask(
        buildTopicGroupingPrompt({
          source_kind: 'project_primary_topics',
          path,
          existing_topics: existing,
          max_new_topics: 1,
          passages: [...local].map(([id, nodeId]) => ({ id, summary: digest(nodes, nodeId) })),
        }),
        (raw) => {
          decoded = decodeAssignment(raw, local, existing, 1);
          return decoded !== null;
        },
        LLM_TASK_TYPES.SUMMARY_TREE_TOPICS,
      );
      for (const [title, members] of (accepted && decoded) || []) {
        if (titles.has(title)) members.forEach((id) => choice.set(id, titles.get(title)));
      }
    }
    return choice;
  }

  let active = [...unitIds];
  while (active.length) {
    const byParent = new Map();
    for (const id of active) {
      const parentId = trail.get(id).at(-1);
      if (!byParent.has(parentId)) byParent.set(parentId, []);
      byParent.get(parentId).push(id);
    }
    const next = [];
    await Promise.all(
      [...byParent].map(([parentId, ids]) =>
        limit(async () => {
          const branches = nodes[parentId].children.filter(isBranch);
          const choice = branches.length ? await choose(ids, parentId, branches) : new Map();
          for (const id of ids) {
            const branchId = choice.get(id);
            if (branchId) {
              trail.get(id).push(branchId);
              next.push(id);
            } else {
              attach(id);
            }
          }
          await onProgress();
        }),
      ),
    );
    active = next;
  }
}
