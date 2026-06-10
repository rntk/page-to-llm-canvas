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

export { getHierarchyTopicAccentColor as topicAccentColor };

/**
 * Build summary cards from record: one card per node in topic_summary_index
 * (preferred) or fall back to leaf topic_summaries.
 */
export function buildSummaryEntries(record) {
  const out = [];
  const index = record.topic_summary_index;
  const sentenceNumbersByPath = new Map();

  if (index && typeof index === 'object' && Object.keys(index).length > 0) {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitPath(rawPath);
      const path = parts.join(' > ');
      const sourceSentences = Array.isArray(entry.source_sentences)
        ? entry.source_sentences.slice().sort((a, b) => a - b)
        : [];
      const level = typeof entry.level === 'number' ? entry.level : parts.length - 1;
      sentenceNumbersByPath.set(path, sourceSentences);
      out.push({
        path,
        name: parts[parts.length - 1] || path,
        text: (entry.text || '').trim(),
        sourceSentences,
        level,
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
      out.push({
        path,
        name: parts[parts.length - 1] || path,
        text: (summary.text || '').trim(),
        sourceSentences,
        level: parts.length - 1,
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
