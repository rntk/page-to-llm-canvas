import { getHierarchyTopicAccentColor } from '../../../utils/topicColorUtils.js';
import {
  splitTopicPath,
  getTopicSentenceNumbers,
  computeMaxTopicLevelForRecord,
  requireTopicSummaryLevel,
} from '../../../domain/topicDomain.js';

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
    const rendered =
      Array.isArray(runs) && runs.length > 0
        ? runs.map((run) => ({
            sentences: Array.isArray(run.sentences)
              ? run.sentences.slice().sort((a, b) => a - b)
              : [],
            text: typeof run.text === 'string' ? run.text.trim() : '',
          }))
        : splitIntoContiguousRuns(sourceSentences).map((run) => ({ sentences: run, text: '' }));
    for (const run of rendered) {
      if (!run.text) continue;
      out.push({ path, name, text: run.text, sourceSentences: run.sentences, level });
    }
  };

  if (!index || typeof index !== 'object') return { entries: out, sentenceNumbersByPath };
  for (const [rawPath, entry] of Object.entries(index)) {
    if (!rawPath) continue;
    const parts = splitTopicPath(rawPath);
    const path = parts.join(' > ');
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

export function buildHierarchicalTopicEntries(record, selectedLevel) {
  const topics = Array.isArray(record.topics) ? record.topics : [];
  const nodes = new Map();

  for (const t of topics) {
    const parts = splitTopicPath(t.name);
    const limit = Math.min(parts.length, selectedLevel + 1);
    const sentences = getTopicSentenceNumbers(t);

    for (let i = 0; i < limit; i++) {
      const path = parts.slice(0, i + 1).join(' > ');
      const name = parts[i];
      if (!nodes.has(path)) {
        nodes.set(path, {
          path,
          name,
          level: i,
          sentences: new Set(),
        });
      }
      const node = nodes.get(path);
      for (const s of sentences) {
        node.sentences.add(s);
      }
    }
  }

  return Array.from(nodes.values()).map((node) => ({
    path: node.path,
    name: node.name,
    level: node.level,
    sentences: Array.from(node.sentences).sort((a, b) => a - b),
  }));
}

export function splitIntoContiguousRuns(sentences) {
  const sorted = (sentences || []).slice().sort((a, b) => a - b);
  const runs = [];
  let cur = [];
  for (const s of sorted) {
    if (cur.length === 0 || s === cur[cur.length - 1] + 1) {
      cur.push(s);
    } else {
      runs.push(cur);
      cur = [s];
    }
  }
  if (cur.length) runs.push(cur);
  return runs;
}
