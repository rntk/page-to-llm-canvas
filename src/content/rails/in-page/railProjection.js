/**
 * Project record entries onto DOM sentence geometry for the in-page rail.
 */

import { resolveColumnOverlaps } from '../../../domain/topicCards.js';
import {
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
} from '../shared/railCards.js';
import { computeCardVerticalBox } from './geometry.js';

/**
 * Project a record into positioned rail cards.
 *
 * @param {object} opts
 * @param {object} opts.record Record being displayed.
 * @param {string} opts.mode Rail mode ('topics' | 'summaries' | 'chat').
 * @param {number} opts.selectedLevel Hierarchy level being shown.
 * @param {Map|object} opts.sentenceRanges Sentence-number → word-range index.
 * @param {Array} opts.wordEntries Word entries collected from the picked elements.
 * @param {number} opts.railOriginTop Rail body offset the card boxes are relative to.
 * @param {Window|Element|null} opts.scrollContainer Scroller the rail follows.
 * @returns {object[]} Positioned cards, ordered top to bottom.
 */
export function buildRailCards({
  record,
  mode,
  selectedLevel,
  sentenceRanges,
  wordEntries,
  railOriginTop,
  scrollContainer,
  win = window,
}) {
  const isSummary = mode === 'summaries';
  const entries = isSummary
    ? buildSummaryEntries(record).entries
    : buildHierarchicalTopicEntries(record, selectedLevel);
  const eligible = entries.filter((e) => e.level === selectedLevel);

  const cardSpecs = [];
  for (const e of eligible) {
    const allSentences = isSummary ? e.sourceSentences : e.sentences;
    const runs = splitIntoContiguousRuns(allSentences);
    for (const run of runs) {
      const box = computeCardVerticalBox(
        run,
        sentenceRanges,
        wordEntries,
        railOriginTop,
        scrollContainer,
        { win },
      );
      if (!box) continue;
      const accent = topicAccentColor(e.path, e.level || 0);
      cardSpecs.push({
        ...e,
        id: `${e.path}-${run.join('-')}`,
        sentences: run,
        allSentences,
        box,
        accent,
      });
    }
  }

  // Bound overlap corrections so mismeasured cards stay near their sentences.
  const resolved = resolveColumnOverlaps(
    cardSpecs.map((card) => ({
      key: card.id,
      levelIndex: card.level || 0,
      startSentence: card.sentences[0] ?? 0,
      fullPath: card.path,
      top: card.box.top,
      height: card.box.height,
    })),
  );
  const adjustedById = new Map(resolved.map((card) => [card.key, card]));
  for (const card of cardSpecs) {
    const adjusted = adjustedById.get(card.id);
    if (adjusted) card.box = { ...card.box, top: adjusted.top, height: adjusted.height };
  }
  cardSpecs.sort((a, b) => a.box.top - b.box.top);

  return cardSpecs;
}
