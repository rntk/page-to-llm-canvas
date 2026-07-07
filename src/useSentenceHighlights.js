import { useEffect } from 'react';
import {
  HIGHLIGHT_NAME,
  supportsHighlightApi,
  buildSentenceDomRange,
} from './sentenceHighlight.js';

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
 * @param {{
 *   isDone: boolean,
 *   showSummaryMode: boolean,
 *   topicSentenceIndex: Map<string, Iterable<number>>,
 *   selectedTopicKey: string | null,
 *   hoveredTopicKey: string | null,
 *   articleHtml: string,
 *   refreshSentenceRanges: () => { wordEntries: Array<unknown>, sentenceRanges: Map<number, unknown> },
 * }} params
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

    const setHighlight = (name, nums) => {
      if (!nums.length) {
        CSS.highlights.delete(name);
        return;
      }
      const highlight = new Highlight();
      let any = false;
      for (const n of nums) {
        const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, n);
        if (domRange) {
          highlight.add(domRange);
          any = true;
        }
      }
      if (any) CSS.highlights.set(name, highlight);
      else CSS.highlights.delete(name);
    };

    const selectedNums = sentencesForKey(selectedTopicKey);
    const selectedSet = new Set(selectedNums);
    // Don't double-paint sentences that are already in the selected highlight.
    const hoverNums = sentencesForKey(hoveredTopicKey).filter((n) => !selectedSet.has(n));

    setHighlight(HIGHLIGHT_NAME, selectedNums);
    setHighlight(HIGHLIGHT_HOVER, hoverNums);

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
