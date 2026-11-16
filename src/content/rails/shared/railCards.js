import { getHierarchyTopicAccentColor } from '../../../domain/topicColorUtils.js';
import {
  splitTopicPath,
  buildTopicHierarchyTree,
  flattenTopicHierarchy,
  computeMaxTopicLevelForRecord,
  normalizeSummaryRuns,
  requireTopicSummaryLevel,
  splitSentenceRuns,
} from '../../../domain/topicDomain.js';
import { formatTopicPath } from '../../../shared/runtime/topicPath.js';
import { sortedUnique } from '../../../shared/runtime/sortedUnique.js';

/**
 * Deepest topic level in a record, from topic `name` path depth and
 * `topic_summary_index` levels (so summary-only levels count). Drives the
 * rail's level selector.
 *
 * @param {object} record
 * @param {Array<{name: string}>} [record.topics]
 * @param {Record<string, {level: number}>} [record.topic_summary_index]
 * @returns {number} The maximum 0-based level.
 */
export function computeMaxTopicLevel(record) {
  return computeMaxTopicLevelForRecord(record);
}

export { getHierarchyTopicAccentColor as topicAccentColor };

/**
 * Build summary entries: one per contiguous run of each topic_summary_index
 * node, so a topic recurring in non-adjacent places yields an entry per
 * occurrence with that run's own text and sentences. `sentenceNumbersByPath`
 * keeps the full aggregated sentence set per path.
 * @param {object} record Record containing topic summaries.
 */
export function buildSummaryEntries(record) {
  const out = [];
  const index = record.topic_summary_index;
  const sentenceNumbersByPath = new Map();

  // Skip runs without summary text so failed/skipped summaries yield no empty cards.
  const pushRuns = ({ path, name, level, runs, sourceSentences }) => {
    for (const run of normalizeSummaryRuns(runs, sourceSentences)) {
      if (!run.text) continue;
      out.push({ path, name, text: run.text, sourceSentences: run.sentences, level });
    }
  };

  if (!index || typeof index !== 'object') return { entries: out, sentenceNumbersByPath };
  for (const [rawPath, entry] of Object.entries(index)) {
    if (!rawPath) continue;
    const parts = splitTopicPath(rawPath);
    const path = formatTopicPath(parts);
    const level = requireTopicSummaryLevel(rawPath, entry);
    const sourceSentences = Array.isArray(entry.source_sentences)
      ? entry.source_sentences.slice().sort((a, b) => a - b)
      : [];
    sentenceNumbersByPath.set(path, sourceSentences);
    pushRuns({
      path,
      name: parts[parts.length - 1] || path,
      level,
      runs: entry.runs,
      sourceSentences,
    });
  }
  return { entries: out, sentenceNumbersByPath };
}

/**
 * Flatten the canonical topic hierarchy into the rail's entry shape: one entry
 * per distinct path up to `selectedLevel`, in first-seen order.
 *
 * @param {object} record
 * @param {number} selectedLevel
 * @returns {Array<{path: string, name: string, level: number, sentences: number[]}>}
 */
export function buildHierarchicalTopicEntries(record, selectedLevel) {
  const tree = buildTopicHierarchyTree(record.topics, selectedLevel);
  return flattenTopicHierarchy(tree).map((node) => ({
    path: node.fullPath,
    name: node.name,
    level: node.depth,
    sentences: sortedUnique(node.sentences),
  }));
}

export { splitSentenceRuns as splitIntoContiguousRuns };
