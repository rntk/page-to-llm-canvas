import { getHierarchyTopicAccentColor } from '../utils/topicColorUtils.js';

export function getTopicSentenceNumbers(topic) {
  if (Array.isArray(topic.sentences) && topic.sentences.length) {
    return topic.sentences.slice().sort((a, b) => a - b);
  }
  const set = new Set();
  (topic.ranges || []).forEach((r) => {
    const s = Number(r.sentence_start);
    const rawEnd =
      r.sentence_end === null || r.sentence_end === undefined || r.sentence_end === ''
        ? r.sentence_start
        : r.sentence_end;
    const e = Number(rawEnd);
    if (!Number.isInteger(s) || !Number.isInteger(e)) return;
    for (let i = Math.min(s, e); i <= Math.max(s, e); i++) set.add(i);
  });
  return Array.from(set).sort((a, b) => a - b);
}

export function splitPath(name) {
  return String(name || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Compute the deepest topic level present in a record, considering both the
 * topic list (depth from `name` path) and the `topic_summary_index` (each
 * entry's explicit `level`, or its path depth when absent). Drives the rail's
 * level selector, so summary-only levels count even when no topic reaches them.
 *
 * @param {{topics?: Array<{name?: string}>, topic_summary_index?: Record<string, {level?: number}>}} record
 * @returns {number} The maximum 0-based level.
 */
export function computeMaxTopicLevel(record) {
  let maxLevel = 0;
  const topics = Array.isArray(record.topics) ? record.topics : [];
  for (const t of topics) {
    const depth = splitPath(t.name).length - 1;
    if (depth > maxLevel) maxLevel = depth;
  }
  const index = record.topic_summary_index;
  if (index && typeof index === 'object') {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitPath(rawPath);
      const indexEntry = entry && typeof entry === 'object' ? entry : {};
      const level = typeof indexEntry.level === 'number' ? indexEntry.level : parts.length - 1;
      if (level > maxLevel) maxLevel = level;
    }
  }
  return maxLevel;
}

export { getHierarchyTopicAccentColor as topicAccentColor };

/**
 * Build summary entries from record: ONE entry per contiguous run of each node in
 * topic_summary_index (preferred) or leaf topic_summaries. A topic that recurs at
 * non-adjacent places yields one entry per occurrence, each carrying that run's
 * own summary text and its own sentences, so rails position location-specific
 * summaries instead of repeating one blob. `sentenceNumbersByPath` keeps the full
 * aggregated sentence set per path.
 */
export function buildSummaryEntries(record) {
  const out = [];
  const index = record.topic_summary_index;
  const sentenceNumbersByPath = new Map();

  // Emit one entry per run; fall back to positioned empty runs (split from the
  // aggregated sentences) so an errored/skipped topic still appears on the rail.
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
      out.push({ path, name, text: run.text, sourceSentences: run.sentences, level });
    }
  };

  if (index && typeof index === 'object' && Object.keys(index).length > 0) {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const indexEntry = entry && typeof entry === 'object' ? entry : {};
      const parts = splitPath(rawPath);
      const path = parts.join(' > ');
      const sourceSentences = Array.isArray(indexEntry.source_sentences)
        ? indexEntry.source_sentences.slice().sort((a, b) => a - b)
        : [];
      const level = typeof indexEntry.level === 'number' ? indexEntry.level : parts.length - 1;
      sentenceNumbersByPath.set(path, sourceSentences);
      pushRuns({
        path,
        name: parts[parts.length - 1] || path,
        level,
        runs: indexEntry.runs,
        sourceSentences,
      });
    }
  } else {
    const topics = Array.isArray(record.topics) ? record.topics : [];
    const summaries = record.topic_summaries || {};
    for (const topic of topics) {
      const parts = splitPath(topic.name);
      const path = parts.join(' > ');
      const summary = summaries[topic.name] || summaries[path] || {};
      const sourceSentences = (
        Array.isArray(summary.source_sentences)
          ? summary.source_sentences
          : getTopicSentenceNumbers(topic)
      )
        .slice()
        .sort((a, b) => a - b);
      sentenceNumbersByPath.set(path, sourceSentences);
      pushRuns({
        path,
        name: parts[parts.length - 1] || path,
        level: parts.length - 1,
        runs: summary.runs,
        sourceSentences,
      });
    }
  }
  return { entries: out, sentenceNumbersByPath };
}

export function buildHierarchicalTopicEntries(record, selectedLevel) {
  const topics = Array.isArray(record.topics) ? record.topics : [];
  const nodes = new Map();

  for (const t of topics) {
    const parts = splitPath(t.name);
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
