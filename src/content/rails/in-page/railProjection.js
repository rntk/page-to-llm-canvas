/**
 * Card projection for the in-page rail, extracted from openInPageRail in
 * src/content/rails/in-page/controller.jsx.
 *
 * Pure with respect to rail state: everything it needs (record, mode, level,
 * measured geometry inputs) arrives as arguments, so it holds no closure over
 * the live rail. Measurement itself still goes through geometry.js, which reads
 * the DOM through the ranges it is handed.
 */

import { resolveColumnOverlaps } from '../../../domain/topicCards.js';
import {
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
} from '../shared/railCards.js';
import { computeCardVerticalBox, computeRailTrailingPad } from './geometry.js';

/** Body height used before the rail has been measured or when it has no cards. */
export const FALLBACK_RAIL_BODY_HEIGHT = 200;

/**
 * Project a record into positioned rail cards plus the rail body height.
 *
 * @param {object} opts
 * @param {object} opts.record Record being displayed.
 * @param {string} opts.mode Rail mode ('topics' | 'summaries' | 'chat').
 * @param {number} opts.selectedLevel Hierarchy level being shown.
 * @param {Map|object} opts.sentenceRanges Sentence-number → word-range index.
 * @param {Array} opts.wordEntries Word entries collected from the picked elements.
 * @param {number} opts.railOriginTop Document offset the card boxes are relative to.
 * @param {Window|Element|null} opts.scrollContainer Scroller the rail follows.
 * @returns {{ cards: object[], bodyHeight: number }}
 */
export function buildRailCards({
  record,
  mode,
  selectedLevel,
  sentenceRanges,
  wordEntries,
  railOriginTop,
  scrollContainer,
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

  // Mirror the canvas hierarchy rail: cards in a column must never overlap.
  // Each card already spans one contiguous sentence run, but a mis-measured
  // run can stretch a card across its neighbours and hide the cards in
  // between. resolveColumnOverlaps clips/pushes them into a clean stack.
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
    if (adjusted) card.box = { top: adjusted.top, height: adjusted.height };
  }
  cardSpecs.sort((a, b) => a.box.top - b.box.top);

  const trailingPad = computeRailTrailingPad({ isSummary, scrollContainer });
  const railHeight = cardSpecs.length
    ? Math.max(...cardSpecs.map((c) => c.box.top + c.box.height)) + trailingPad
    : FALLBACK_RAIL_BODY_HEIGHT;
  return { cards: cardSpecs, bodyHeight: railHeight };
}
