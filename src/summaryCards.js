import { splitTopicPath, splitSentenceRuns } from './topicCards.js';

/**
 * Formats a summary object into a single plain-text string (with bullet prefixing).
 * @param {object} summary - The summary object containing optional text and bullets.
 * @returns {string} The formatted plain text.
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

/**
 * Filters allSummaryCards to one card per topic branch at the current
 * selected level. A card is kept when it is the deepest eligible card for its
 * branch (no eligible card with a strictly-longer path that is a descendant).
 * Cards are sorted by startSentence then path so they align with the rail.
 *
 * @param {Array} allSummaryCards - Full set of summary cards as returned by buildSummaryCards.
 * @param {number} selectedLevel - The currently selected maximum level index (0-based).
 * @returns {Array} Filtered and sorted summary cards.
 */
export function filterSummaryCardsByLevel(allSummaryCards, selectedLevel) {
  const eligible = allSummaryCards.filter((card) => card.levelIndex <= selectedLevel);
  const paths = new Set(eligible.map((c) => c.path));
  // A card is an ancestor if any other path extends it with ' > …'.
  // Build the ancestor set in O(n·d) where d = average path depth, not O(n²).
  const hasDescendant = new Set();
  for (const p of paths) {
    let sep = p.indexOf(' > ');
    while (sep !== -1) {
      hasDescendant.add(p.slice(0, sep));
      sep = p.indexOf(' > ', sep + 3);
    }
  }
  return eligible
    .filter((card) => !hasDescendant.has(card.path))
    .sort((a, b) => a.startSentence - b.startSentence || a.path.localeCompare(b.path));
}

/**
 * Pure helper that turns record.topics + record.topic_summaries (legacy) or
 * record.topic_summary_index (preferred, hierarchical) into the
 * summaryViewCards[] array consumed by CanvasSummaryView.
 *
 * @param {Array} topics
 * @param {object} topicSummaries
 * @param {object} topicSummaryIndex
 * @returns {Array} Card shape: { key, path, name, text, sourceSentences, startSentence, levelIndex }
 */
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
