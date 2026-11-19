import { projectArticleView } from '../../../domain/articleView.js';
// Map transcript timestamps to YouTube rail cards and playback position.

import {
  getTimestampForSentences,
  parseTimestampSeconds,
} from '../../../utils/youtubeTimestamp.js';
import { gapToSpans, suggestBetterLevel } from '../shared/levelHint.js';
import {
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
  topicAccentColor,
} from '../shared/railCards.js';

export const LEVEL_HINT_TOLERANCE_SECONDS = 5;

/**
 * Build the ordered, timestamped card list for the YouTube rail.
 *
 * Cards use the nearest preceding transcript timestamp; untimed entries are
 * omitted and the rest are sorted in playback order. Topics split into
 * contiguous sentence runs, merging runs at the same second; each summary run
 * yields at most one card. IDs include path and sentences so runs sharing a
 * timestamp stay distinct.
 *
 * `endSeconds` (exclusive) is the next transcript cue after the run's last
 * sentence, or null when the run is open-ended (no later cue). Merged runs keep
 * the latest end, with open-ended winning.
 *
 * `spans` lists the covered time per contiguous sentence group of the card
 * (`end` null = open-ended), so a card over non-adjacent sentences does not
 * count the gap between them as covered. `endSeconds` is the card-level max end.
 *
 * @param {object} input Record and selected rail mode/level.
 * @param {object} [input.record] Article record supplying sentences.
 * @param {string[]} [input.record.sentences] Article sentences in display order.
 * @param {'summaries'|'topics'} input.mode Which card set the rail renders.
 * @param {number} [input.selectedLevel] Hierarchy level the rail is scoped to.
 * @returns {Array<{ id: string, name: string, text: string, path: string,
 *   level: number, seconds: number, endSeconds: number|null, accent: string,
 *   sentences: number[], spans: Array<{start: number, end: number|null}> }>}
 */
export function buildYouTubeRailCards({ record, mode, selectedLevel = 0 }) {
  if (!record || typeof record !== 'object') return [];
  const { sentences } = projectArticleView(record);
  const isSummary = mode === 'summaries';

  // Mixing hierarchy levels would make the current card jump during playback.
  const allEntries = isSummary
    ? buildSummaryEntries(record).entries
    : buildHierarchicalTopicEntries(record, selectedLevel);
  const entries = allEntries.filter((e) => e.level === selectedLevel);

  // Cue seconds per sentence, parsed lazily and once.
  const cueSeconds = new Array(sentences.length);
  const cueAt = (index) => {
    if (cueSeconds[index] === undefined)
      cueSeconds[index] = parseTimestampSeconds(sentences[index]);
    return cueSeconds[index];
  };
  const endSecondsForRun = (run) => {
    const numbers = Array.isArray(run) ? run.filter((n) => Number.isInteger(n) && n > 0) : [];
    if (numbers.length === 0) return null;
    // Sentence numbers are 1-based, so index `last` is the sentence after the run.
    for (let i = Math.max(...numbers); i < sentences.length; i += 1) {
      const cue = cueAt(i);
      if (cue != null) return cue;
    }
    return null;
  };

  const cards = [];
  for (const entry of entries) {
    const allSentences = isSummary ? entry.sourceSentences : entry.sentences;
    // Split aggregated topics into runs; summaries already represent runs.
    const runs = isSummary ? [allSentences] : splitIntoContiguousRuns(allSentences);
    const entryCardsBySeconds = new Map();

    for (const run of runs) {
      const seconds = getTimestampForSentences(sentences, run);
      if (seconds == null) continue;

      // One span per contiguous sentence group, so gaps between groups stay uncovered.
      const spans = [];
      for (const group of splitIntoContiguousRuns(run)) {
        const start = getTimestampForSentences(sentences, group);
        if (start == null) continue;
        spans.push({ start, end: endSecondsForRun(group) });
      }

      // Merge runs of one topic that resolve to the same second.
      const endSeconds = endSecondsForRun(run);
      const existing = entryCardsBySeconds.get(seconds);
      if (existing) {
        existing.endSeconds =
          existing.endSeconds == null || endSeconds == null
            ? null
            : Math.max(existing.endSeconds, endSeconds);
        existing.spans.push(...spans);
        existing.sentences.push(...run);
        existing.sentences.sort((a, b) => a - b);
        existing.id = `${entry.path}-${existing.sentences.join('-')}`;
      } else {
        const cardSentences = Array.isArray(run) ? run.slice().sort((a, b) => a - b) : [];
        const card = {
          id: `${entry.path}-${cardSentences.join('-')}`,
          name: entry.name,
          text: (entry.text || '').trim(),
          path: entry.path,
          level: entry.level || 0,
          seconds,
          endSeconds,
          accent: topicAccentColor(entry.path, entry.level || 0),
          sentences: cardSentences,
          spans,
        };
        entryCardsBySeconds.set(seconds, card);
        cards.push(card);
      }
    }
  }

  cards.sort((a, b) => a.seconds - b.seconds);
  return cards;
}

/**
 * Index of the "current" card for a player time: the last card starting at or
 * before `currentTime`. Times before the first card clamp to it; -1 for no cards.
 *
 * @param {number[]} starts ascending start seconds, one per card
 * @param {number} currentTime player position in seconds
 * @returns {number}
 */
export function findActiveCardIndex(starts, currentTime) {
  if (!Array.isArray(starts) || starts.length === 0) return -1;
  if (!Number.isFinite(currentTime)) return 0;
  let active = -1;
  for (let i = 0; i < starts.length; i += 1) {
    if (starts[i] <= currentTime) active = i;
    else break;
  }
  return active === -1 ? 0 : active;
}

/**
 * Level worth suggesting for a player time, or null when the selected level
 * already covers it (within `tolerance` seconds) or no other level does better.
 *
 * @param {object} input
 * @param {Array<Array<{seconds: number, endSeconds?: number|null,
 *   spans?: Array<{start: number, end: number|null}>}>>|Map<number, Array>} input.levelCards
 *   Cards per hierarchy level (array index or map key = level).
 * @param {number} input.selectedLevel
 * @param {number} input.currentTime player position in seconds
 * @param {number} [input.tolerance] seconds still counted as covered
 * @returns {number|null}
 */
export function suggestLevelForTime({
  levelCards,
  selectedLevel,
  currentTime,
  tolerance = LEVEL_HINT_TOLERANCE_SECONDS,
}) {
  if (!Number.isFinite(currentTime)) return null;
  const entries =
    levelCards instanceof Map ? [...levelCards] : Array.from(levelCards || [], (c, i) => [i, c]);
  const gaps = new Map();
  for (const [level, cards] of entries) {
    if (!Array.isArray(cards)) continue;
    const spans = cards.flatMap((card) => {
      if (Array.isArray(card?.spans)) {
        return card.spans.map((span) => ({
          start: Number(span?.start),
          end: Number.isFinite(span?.end) ? span.end : null,
        }));
      }
      return [
        {
          start: Number(card?.seconds),
          end: Number.isFinite(card?.endSeconds) ? card.endSeconds : null,
        },
      ];
    });
    gaps.set(level, gapToSpans(spans, currentTime));
  }
  return suggestBetterLevel({ selectedLevel, gaps, tolerance });
}
