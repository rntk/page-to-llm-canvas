// Dependency-driven summary requests with local citation validation. Each
// request carries one node under the stable id "item"; a parent becomes
// eligible as soon as its children are done. Only the coordinator mutates
// nodes; workers return validated segments.

import { LLM_TASK_TYPES } from '../metrics/llm.js';
import { LEVEL, PASSAGE, TOPIC, cleanTitle, relay } from './summaryTreeModel.js';
import { buildSummaryTreeSummaryPrompt, claimSupportedQuestion, NO } from './summaryTreePrompts.js';
import { extractObject, yesProbability } from './summaryTreeAnswers.js';

/** @import { SummaryTreeNode, SummaryLevel } from './summaryTreeModel.js' */

const ITEM_ID = 'item';
const CITED_CHARS = 4000;
const VERIFIED_LEVELS = new Set([LEVEL.PASSAGE, LEVEL.DETAIL]);
const CONNECTORS = new Set(['and', 'or', 'but', 'while', 'also', 'и', 'а', 'но', 'или']);

/**
 * Raised when a topic never gets a valid cited summary.
 */
export class SummaryTreeGenerationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SummaryTreeGenerationError';
  }
}

/**
 * Which prompt intent summarizes `node`.
 * @param {SummaryTreeNode} node
 * @param {Record<string, SummaryTreeNode>} nodes
 * @returns {SummaryLevel}
 */
export function levelOf(node, nodes) {
  if (node.kind === PASSAGE) return LEVEL.PASSAGE;
  if (!node.children.some((child) => nodes[child].kind === TOPIC)) return LEVEL.DETAIL;
  return node.kind === TOPIC ? LEVEL.OVERVIEW : LEVEL.ROOT;
}

/**
 * Request payload for one node and the citation labels its answer may use.
 * @param {SummaryTreeNode} node
 * @param {Record<string, SummaryTreeNode>} nodes
 * @param {string[]} sentenceTexts
 * @param {function(object): object|null} [sourceOf] Origin shown to the model for a child node.
 * @returns {{item: object, allowed: Map<string, object>}}
 */
export function requestItem(node, nodes, sentenceTexts, sourceOf = () => null) {
  const allowed = new Map();
  const item = { id: ITEM_ID, kind: node.kind };
  if (node.kind === PASSAGE) {
    item.evidence = node.sentences
      .map((id) => `${id}|${String(sentenceTexts[id - 1] || '').replace(/\s+/gu, ' ')}`)
      .join('\n');
    for (const id of node.sentences) allowed.set(String(id), { kind: 'rows', first: id, last: id });
    return { item, allowed };
  }
  item.title = node.title;
  if (node.path.length) item.path = node.path.join(' › ');
  item.children = node.children.map((childId, position) => {
    const child = nodes[childId];
    const claims = [];
    (child.segments || []).forEach((segment, index) => {
      if (!segment.sources.length) return;
      const label = `C${position + 1}.S${index + 1}`;
      allowed.set(label, { kind: 'claim', child: child.id, segment: index });
      claims.push({ cite: label, text: segment.text.trim() });
    });
    const source = sourceOf(child);
    return { title: child.title, claims, ...(source ? { source } : {}) };
  });
  return { item, allowed };
}

function decodeSource(label, allowed) {
  if (typeof label !== 'string') return null;
  const known = allowed.get(label.trim());
  if (known) return known;
  const match = /^(\d+)\s*-\s*(\d+)$/u.exec(label.trim());
  if (!match) return null;
  const [first, last] = [Number(match[1]), Number(match[2])];
  if (first > last || last - first > allowed.size) return null;
  for (let id = first; id <= last; id++) {
    if (allowed.get(String(id))?.kind !== 'rows') return null;
  }
  return { kind: 'rows', first, last };
}

/**
 * Validated segments of one answer entry. Unknown labels reject the answer;
 * prose without citations may only connect claims.
 * @param {unknown} entry
 * @param {Map<string, object>} allowed
 * @returns {Array<{text: string, sources: object[]}>|null} Empty when nothing is cited.
 */
export function decodeEntry(entry, allowed) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.segments)) return null;
  const segments = [];
  for (const part of entry.segments) {
    if (!part || typeof part.text !== 'string' || !Array.isArray(part.from)) return null;
    let text = part.text;
    if (!text.trim()) continue;
    const sources = [];
    for (const label of part.from) {
      const source = decodeSource(label, allowed);
      if (!source) return null;
      if (!sources.some((known) => JSON.stringify(known) === JSON.stringify(source))) {
        sources.push(source);
      }
    }
    const words = text.match(/[\p{L}\p{N}]+/gu) || [];
    if (!sources.length && words.some((word) => !CONNECTORS.has(word.toLowerCase()))) return null;
    if (segments.length && /^[\p{L}\p{N}]/u.test(text)) {
      const last = segments.at(-1).text.slice(-1);
      if (/[\p{L}\p{N}.!?,;:)]/u.test(last)) text = ` ${text}`;
    }
    segments.push({ text, sources });
  }
  // Connecting prose alone is not a summary.
  return segments.some((segment) => segment.sources.length) ? segments : [];
}

/**
 * Drops claims the decision provider finds unsupported by their citations.
 * Judge failures keep the answer as validated by citations alone.
 * @param {object} input
 * @param {object} input.judge Summary tree judge.
 * @param {Record<string, SummaryTreeNode>} input.nodes
 * @param {string[]} input.sentenceTexts
 */
export function createClaimVerifier({ judge, nodes, sentenceTexts }) {
  const metrics = { dropped: 0 };

  const cited = (segment) => {
    const texts = segment.sources.map((source) =>
      source.kind === 'rows'
        ? sentenceTexts.slice(source.first - 1, source.last).join(' ')
        : (nodes[source.child]?.segments?.[source.segment]?.text || '').trim(),
    );
    const out = [];
    let size = 0;
    for (const text of texts) {
      const part = text.slice(0, Math.max(0, CITED_CHARS - size));
      size += part.length;
      if (part) out.push(part);
    }
    return out;
  };

  /**
   * @param {SummaryLevel} level
   * @param {Array<{text: string, sources: object[]}>} segments
   * @returns {Promise<Array<{text: string, sources: object[]}>|null>} Null when every claim failed.
   */
  async function filter(level, segments) {
    if (!VERIFIED_LEVELS.has(level) || !judge?.active || !segments.length) return segments;
    const claims = {};
    const questions = {};
    segments.forEach((segment, index) => {
      if (!segment.sources.length) return;
      const key = `s${index}`;
      claims[key] = { claim: segment.text.trim(), cited: cited(segment) };
      questions[key] = claimSupportedQuestion(key);
    });
    const answers = await judge.ask({ claims }, questions);
    if (!answers) return segments;
    const kept = segments.filter((segment, index) => {
      const score = segment.sources.length ? yesProbability(answers, `s${index}`) : null;
      if (score !== null && score < NO) {
        metrics.dropped++;
        return false;
      }
      return true;
    });
    if (kept.length === segments.length) return segments;
    const first = kept.findIndex((segment) => segment.sources.length);
    if (first === -1) return null;
    let last = kept.length - 1;
    while (!kept[last].sources.length) last--;
    const tidy = kept.slice(first, last + 1).map((segment) => ({ ...segment }));
    tidy[0].text = tidy[0].text.trimStart();
    return tidy;
  }

  return { filter, metrics };
}

/**
 * Summarize `targets` bottom-up; their descendants must be done or among them.
 * With `tolerateFailures` a node that never gets a valid answer is marked
 * `failed` with no segments instead of failing the stage.
 * @param {object} input
 * @param {Record<string, SummaryTreeNode>} input.nodes
 * @param {string[]} input.targets
 * @param {string[]} input.sentenceTexts
 * @param {{ask: Function}} input.llm
 * @param {{filter: Function}} [input.verifier]
 * @param {number} [input.workers]
 * @param {boolean} [input.tolerateFailures]
 * @param {function(object): Promise<void>} [input.onNodeDone] Persists progress.
 * @param {AbortController} [input.controller] Aborted to stop siblings after a failure.
 * @param {function(object): object|null} [input.sourceOf] Origin shown to the model for a child node.
 */
export async function generateSummaries({
  nodes,
  targets,
  sentenceTexts,
  llm,
  verifier,
  workers = 4,
  tolerateFailures = false,
  onNodeDone = async () => {},
  controller,
  sourceOf,
}) {
  const generateOne = async (node) => {
    const { item, allowed } = requestItem(node, nodes, sentenceTexts, sourceOf);
    const level = levelOf(node, nodes);
    let result = null;
    let title = null;
    const accepted = await llm.ask(
      buildSummaryTreeSummaryPrompt(level, [item]),
      async (raw) => {
        const entries = extractObject(raw)?.summaries;
        if (!Array.isArray(entries) || entries.length !== 1 || entries[0]?.id !== ITEM_ID) {
          return false;
        }
        let parsed = decodeEntry(entries[0], allowed);
        if (parsed && verifier) parsed = await verifier.filter(level, parsed);
        if (!parsed || (node.kind !== PASSAGE && !parsed.length)) return false;
        result = parsed;
        title = node.kind === PASSAGE ? cleanTitle(entries[0].title) : null;
        return true;
      },
      LLM_TASK_TYPES.SUMMARY_TREE_SUMMARY,
    );
    return accepted ? { segments: result, title } : null;
  };

  const pending = new Map();
  const settle = async () => {
    await Promise.all(pending.values());
    pending.clear();
  };
  try {
    while (true) {
      const todo = targets.filter((id) => nodes[id].segments === null && !pending.has(id));
      const ready = todo.filter((id) =>
        nodes[id].children.every((child) => nodes[child].segments !== null),
      );
      let relayed = false;
      for (const id of ready) {
        const node = nodes[id];
        const reused = node.children.length
          ? relay(node.children.map((child) => nodes[child]))
          : null;
        if (reused) {
          node.segments = reused;
          relayed = true;
          await onNodeDone(node);
        } else if (pending.size < workers) {
          pending.set(
            id,
            generateOne(node).then(
              (value) => ({ id, value }),
              (error) => ({ id, error }),
            ),
          );
        }
      }
      if (!pending.size) {
        if (!todo.length) return;
        if (relayed) continue;
        throw new Error('Summary tree has unresolved dependencies');
      }
      const { id, value, error } = await Promise.race(pending.values());
      pending.delete(id);
      if (error) throw error;
      const node = nodes[id];
      if (value) {
        node.failed = false;
        node.segments = value.segments;
        if (value.title && !node.topicName) node.title = value.title;
      } else if (tolerateFailures) {
        node.failed = true;
        node.segments = [];
      } else {
        throw new SummaryTreeGenerationError(
          `Could not generate a valid cited summary for “${node.title}”. Retry to resume; completed summaries are kept.`,
        );
      }
      await onNodeDone(node);
    }
  } catch (error) {
    controller?.abort();
    await settle();
    throw error;
  }
}
