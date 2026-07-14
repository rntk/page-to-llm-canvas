import { useEffect } from 'react';
import {
  CHAT_HIGHLIGHT_NAME,
  paintSentenceHighlight,
  supportsHighlightApi,
} from '../sentenceHighlight.js';

// Re-exported for callers that still import the constant from this module.
export { CHAT_HIGHLIGHT_NAME };

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
    paintSentenceHighlight(CHAT_HIGHLIGHT_NAME, sentenceNumbers, { wordEntries, sentenceRanges });
    return () => CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
  }, [articleHtml, isDone, refreshSentenceRanges, sentenceNumbers, showSummaryMode]);
}
