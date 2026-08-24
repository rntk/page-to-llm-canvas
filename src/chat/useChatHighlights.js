import { useEffect } from 'react';
import {
  CHAT_HIGHLIGHT_NAME,
  paintSentenceHighlight,
  supportsHighlightApi,
} from '../highlights/sentenceHighlight.js';

export function useChatHighlights({
  showSummaryMode,
  sentenceNumbers,
  articleHtml,
  refreshSentenceRanges,
}) {
  useEffect(() => {
    if (showSummaryMode || !supportsHighlightApi()) return undefined;
    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    paintSentenceHighlight(CHAT_HIGHLIGHT_NAME, sentenceNumbers, { wordEntries, sentenceRanges });
    return () => CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
  }, [articleHtml, refreshSentenceRanges, sentenceNumbers, showSummaryMode]);
}
