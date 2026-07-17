// Pure helpers for the YouTube-synced in-page rail. Unlike the scroll-driven
// rail (which positions cards by their sentences' DOM geometry), the YouTube
// rail is keyed off the video player's current time: every card carries the
// transcript timestamp (in seconds) that marks where its content begins, and we
// surface the card matching the player's position.
//
// Everything here is DOM-free so it can be unit tested in isolation; the React
// component and the content-script glue stay thin around it.

import { getTimestampForSentences } from '../../../utils/youtubeTimestamp.js';
import {
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  topicAccentColor,
} from '../shared/railCards.js';

/**
 * Build the ordered, timestamped card list for the YouTube rail.
 *
 * Each entry's start second is derived from the nearest preceding inline
 * transcript timestamp for its source sentences. Entries without a resolvable
 * timestamp are dropped (they cannot be synced to a moment in the video), and
 * the rest are sorted ascending by time so the list reads top-to-bottom in
 * playback order.
 *
 * @param {{ sentences?: string[] }} record
 * @param {'summaries' | 'topics'} mode
 * @param {number} selectedLevel
 * @returns {Array<{ id: string, name: string, text: string, path: string,
 *   level: number, seconds: number, accent: string, sentences: number[] }>}
 */
export function buildYouTubeRailCards({ record, mode, selectedLevel = 0 }) {
  if (!record || typeof record !== 'object') return [];
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  const isSummary = mode === 'summaries';

  // Both views are scoped to a single hierarchy level: mixing levels interleaves
  // broad parent cards with granular child cards, so the "current" card jumps
  // between levels instead of advancing cleanly with playback. (Mirrors the
  // scroll rail's `e.level === selectedLevel` filter.)
  const allEntries = isSummary
    ? buildSummaryEntries(record).entries
    : buildHierarchicalTopicEntries(record, selectedLevel);
  const entries = allEntries.filter((e) => e.level === selectedLevel);

  const cards = [];
  for (const entry of entries) {
    const sourceSentences = isSummary ? entry.sourceSentences : entry.sentences;
    const seconds = getTimestampForSentences(sentences, sourceSentences);
    if (seconds == null) continue;
    cards.push({
      id: `${entry.path}-${seconds}`,
      name: entry.name,
      text: (entry.text || '').trim(),
      path: entry.path,
      level: entry.level || 0,
      seconds,
      accent: topicAccentColor(entry.path, entry.level || 0),
      sentences: Array.isArray(sourceSentences) ? sourceSentences.slice() : [],
    });
  }

  cards.sort((a, b) => a.seconds - b.seconds);
  return cards;
}

/**
 * Index of the card that is "current" for a given player time: the last card
 * whose start second is at or before `currentTime`.
 *
 * When the player sits before the first card's timestamp (e.g. an intro that
 * precedes the first topic) we clamp to the first card so the rail always shows
 * something rather than going blank. Returns -1 only when there are no cards.
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
