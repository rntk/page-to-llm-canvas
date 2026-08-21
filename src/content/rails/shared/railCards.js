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

/**
 * Compute the deepest topic level present in a record, considering both the
 * topic list (depth from `name` path) and the `topic_summary_index` (each
 * entry's explicit `level`). Drives the rail's
 * level selector, so summary-only levels count even when no topic reaches them.
 * Delegates to topicDomain.js.
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
 * Build summary entries from record: ONE entry per contiguous run of each node in
 * topic_summary_index. A topic that recurs at
 * non-adjacent places yields one entry per occurrence, each carrying that run's
 * own summary text and its own sentences, so rails position location-specific
 * summaries instead of repeating one blob. `sentenceNumbersByPath` keeps the full
 * aggregated sentence set per path.
 * @param {object} record Record containing topic summaries.
 */
export function buildSummaryEntries(record) {
  const out = [];
  const index = record.topic_summary_index;
  const sentenceNumbersByPath = new Map();

  // Emit only runs with usable summary text. Failed or skipped summaries stay
  // absent from the rail instead of creating empty placeholder cards.
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
    sentences: Array.from(node.sentences).sort((a, b) => a - b),
  }));
}

export { splitSentenceRuns as splitIntoContiguousRuns };
