import { useEffect } from 'react';
import {
  HIGHLIGHT_NAME,
  supportsHighlightApi,
  paintSentenceHighlight,
} from '../../highlights/sentenceHighlight.js';

/** Second CSS Custom Highlight name, used for the hovered (not selected) topic. */
const HIGHLIGHT_HOVER = 'pagetollm-sentence-hover';

/**
 * Paint the selected/hovered topic's sentences with the native CSS Custom
 * Highlight API.
 *
 * A single live Range per sentence paints continuously across whitespace and
 * inline tags. The selected topic and the hovered topic get separate named
 * highlights so they can be styled distinctly via ::highlight() in modal.css.
 *
 * @param {object} params
 * @param {boolean} params.isDone
 * @param {boolean} params.showSummaryMode
 * @param {Map<string, Iterable<number>>} params.topicSentenceIndex
 * @param {?string} params.selectedTopicKey
 * @param {?string} params.hoveredTopicKey
 * @param {string} params.articleHtml
 * @param {function(): {wordEntries: Array<unknown>, sentenceRanges: Map<number, unknown>}} params.refreshSentenceRanges
 * @returns {void}
 */
export function useSentenceHighlights({
  isDone,
  showSummaryMode,
  topicSentenceIndex,
  selectedTopicKey,
  hoveredTopicKey,
  articleHtml,
  refreshSentenceRanges,
}) {
  // ── Sentence highlighting (native CSS Custom Highlight API) ───────────────
  // A single live Range per sentence paints continuously across whitespace and
  // inline tags. The selected topic and the hovered topic get separate named
  // highlights so they can be styled distinctly via ::highlight() in modal.css.
  useEffect(() => {
    if (!isDone || showSummaryMode || !supportsHighlightApi()) return undefined;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();

    const sentencesForKey = (key) => {
      if (!key) return [];
      return Array.from(topicSentenceIndex.get(key) || []);
    };

    const selectedNums = sentencesForKey(selectedTopicKey);
    const selectedSet = new Set(selectedNums);
    // Don't double-paint sentences that are already in the selected highlight.
    const hoverNums = sentencesForKey(hoveredTopicKey).filter((n) => !selectedSet.has(n));

    paintSentenceHighlight(HIGHLIGHT_NAME, selectedNums, { wordEntries, sentenceRanges });
    paintSentenceHighlight(HIGHLIGHT_HOVER, hoverNums, { wordEntries, sentenceRanges });

    return () => {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(HIGHLIGHT_HOVER);
    };
  }, [
    isDone,
    showSummaryMode,
    topicSentenceIndex,
    selectedTopicKey,
    hoveredTopicKey,
    articleHtml,
    refreshSentenceRanges,
  ]);
}
