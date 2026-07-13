import { useEffect } from 'react';
import { buildSentenceDomRange, supportsHighlightApi } from '../sentenceHighlight.js';

export const CHAT_HIGHLIGHT_NAME = 'pagetollm-chat-sentence';

export function useChatHighlights({
  isDone,
  showSummaryMode,
  sentenceNumbers,
  articleHtml,
  refreshSentenceRanges,
}) {
  useEffect(() => {
    if (!isDone || showSummaryMode || !supportsHighlightApi()) return undefined;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    const highlight = new Highlight();
    let hasRanges = false;
    for (const sentenceNumber of sentenceNumbers) {
      const range = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
      if (!range) continue;
      highlight.add(range);
      hasRanges = true;
    }
    if (hasRanges) CSS.highlights.set(CHAT_HIGHLIGHT_NAME, highlight);
    else CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
    return () => CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
  }, [articleHtml, isDone, refreshSentenceRanges, sentenceNumbers, showSummaryMode]);
}
