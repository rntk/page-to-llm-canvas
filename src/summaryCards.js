import { splitTopicPath, splitSentenceRuns } from './topicCards.js';

/**
 * Pure helper that turns record.topics + record.topic_summaries (legacy) or
 * record.topic_summary_index (preferred, hierarchical) into the
 * summaryViewCards[] array consumed by CanvasSummaryView.
 *
 * Card shape: { key, path, name, text, sourceSentences, startSentence, levelIndex }
 */
function summaryText(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const text = typeof summary.text === 'string' ? summary.text.trim() : '';
  const bullets = Array.isArray(summary.bullets)
    ? summary.bullets
        .filter((bullet) => typeof bullet === 'string' && bullet.trim())
        .map((bullet) => `- ${bullet.trim()}`)
    : [];

  return [text, ...bullets].filter(Boolean).join('\n');
}

export function buildSummaryCards(topics, topicSummaries, topicSummaryIndex) {
  const index =
    topicSummaryIndex && typeof topicSummaryIndex === 'object' ? topicSummaryIndex : null;

  if (index && Object.keys(index).length > 0) {
    const cards = [];
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitTopicPath(rawPath);
      const path = parts.join(' > ') || rawPath;
      const name = parts[parts.length - 1] || path;
      const sourceSentences = Array.isArray(entry.source_sentences) ? entry.source_sentences : [];
      const levelIndex = typeof entry.level === 'number' ? entry.level : parts.length - 1;

      const runs = splitSentenceRuns(sourceSentences);
      const runsToProcess = runs.length > 0 ? runs : [[]];

      runsToProcess.forEach((run, runIndex) => {
        const startSentence = run.length ? Math.min(...run) : 0;
        cards.push({
          key: `${path}#${levelIndex}#${runIndex}`,
          path,
          name,
          text: summaryText(entry),
          sourceSentences: run,
          startSentence,
          levelIndex,
        });
      });
    }
    cards.sort(
      (a, b) =>
        a.levelIndex - b.levelIndex ||
        a.startSentence - b.startSentence ||
        a.path.localeCompare(b.path),
    );
    return cards;
  }

  if (!Array.isArray(topics)) return [];
  const summaries = topicSummaries || {};

  const cards = [];
  for (const topic of topics) {
    const parts = splitTopicPath(topic.name);
    const path = parts.join(' > ') || topic.name;
    const name = parts[parts.length - 1] || path;

    const summary = summaries[topic.name] || summaries[path] || {};
    const sourceSentences = Array.isArray(summary.source_sentences)
      ? summary.source_sentences
      : Array.isArray(topic.sentences)
        ? topic.sentences
        : [];
    const levelIndex = parts.length - 1;

    const runs = splitSentenceRuns(sourceSentences);
    const runsToProcess = runs.length > 0 ? runs : [[]];

    runsToProcess.forEach((run, runIndex) => {
      const startSentence = run.length ? Math.min(...run) : 0;
      cards.push({
        key: `${path}#${levelIndex}#${runIndex}`,
        path,
        name,
        text: summaryText(summary),
        sourceSentences: run,
        startSentence,
        levelIndex,
      });
    });
  }

  cards.sort(
    (a, b) =>
      a.levelIndex - b.levelIndex ||
      a.startSentence - b.startSentence ||
      a.path.localeCompare(b.path),
  );
  return cards;
}
