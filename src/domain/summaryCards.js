import { normalizeSummaryRuns, requireTopicSummaryLevel, splitTopicPath } from './topicDomain.js';

/**
 * Applies this surface's run policy on top of the canonical normalization: the
 * canvas summary view keeps text-less runs and guarantees at least one run per
 * entry, so an errored/skipped topic still occupies its place on the rail
 * instead of vanishing.
 *
 * @param {Array<{sentences: number[], text: string}>} runs
 * @param {number[]} sourceSentences
 * @returns {Array<{sentences: number[], text: string}>}
 */
function runsForRender(runs, sourceSentences) {
  const normalized = normalizeSummaryRuns(runs, sourceSentences);
  return normalized.length > 0 ? normalized : [{ sentences: [], text: '' }];
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
 * Pure helper that turns record.topic_summary_index into the summaryViewCards[]
 * array consumed by CanvasSummaryView.
 *
 * @param {object} topicSummaryIndex
 * @returns {Array} Card shape: { key, path, name, text, sourceSentences, startSentence, levelIndex }
 */
export function buildSummaryCards(topicSummaryIndex) {
  const index =
    topicSummaryIndex && typeof topicSummaryIndex === 'object' ? topicSummaryIndex : null;

  if (!index) return [];
  const cards = [];
  for (const [rawPath, entry] of Object.entries(index)) {
    if (!rawPath) continue;
    const parts = splitTopicPath(rawPath);
    const path = parts.join(' > ') || rawPath;
    const name = parts[parts.length - 1] || path;
    const levelIndex = requireTopicSummaryLevel(rawPath, entry);
    const sourceSentences = Array.isArray(entry.source_sentences) ? entry.source_sentences : [];
    const runs = runsForRender(entry.runs, sourceSentences);
    runs.forEach((run, runIndex) => {
      const startSentence = run.sentences.length ? Math.min(...run.sentences) : 0;
      cards.push({
        key: `${path}#${levelIndex}#${runIndex}`,
        path,
        name,
        text: run.text,
        sourceSentences: run.sentences,
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
