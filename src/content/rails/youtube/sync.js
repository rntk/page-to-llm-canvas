import { projectArticleView } from '../../../domain/articleView.js';
// Map transcript timestamps to YouTube rail cards and playback position.

import { getTimestampForSentences } from '../../../utils/youtubeTimestamp.js';
import {
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
  topicAccentColor,
} from '../shared/railCards.js';

/**
 * Build the ordered, timestamped card list for the YouTube rail.
 *
 * Cards use the nearest preceding transcript timestamp; untimed entries are
 * omitted and the rest are sorted in playback order.
 *
 * Topics split into contiguous sentence runs, merging runs at the same second.
 *
 * Each summary run yields at most one card to avoid repeating its text.
 *
 * IDs include path and sentences so runs sharing a timestamp remain distinct.
 *
 * @param {object} input Record and selected rail mode/level.
 * @param {object} [input.record] Article record supplying sentences.
 * @param {string[]} [input.record.sentences] Article sentences in display order.
 * @param {'summaries'|'topics'} input.mode Which card set the rail renders.
 * @param {number} [input.selectedLevel] Hierarchy level the rail is scoped to.
 * @returns {Array<{ id: string, name: string, text: string, path: string,
 *   level: number, seconds: number, accent: string, sentences: number[] }>}
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

  const cards = [];
  for (const entry of entries) {
    const allSentences = isSummary ? entry.sourceSentences : entry.sentences;
    // Split aggregated topics into runs; summaries already represent runs.
    const runs = isSummary ? [allSentences] : splitIntoContiguousRuns(allSentences);
    const entryCardsBySeconds = new Map();

    for (const run of runs) {
      const seconds = getTimestampForSentences(sentences, run);
      if (seconds == null) continue;

      // Merge runs of one topic that resolve to the same second.
      const existing = entryCardsBySeconds.get(seconds);
      if (existing) {
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
          accent: topicAccentColor(entry.path, entry.level || 0),
          sentences: cardSentences,
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
 * Index of the card that is "current" for a given player time: the last card
 * whose start second is at or before `currentTime`.
 *
 * Clamp times before the first card to that card; return -1 for no cards.
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
