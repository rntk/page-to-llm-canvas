import { useLayoutEffect, useRef } from 'react';
import { excerptNodeKey } from './excerptLinks.js';

/**
 * Opens and acknowledges a focus request once its excerpt chat is available.
 * @param {object} options Focus id, excerpts, chat renderer, opener and acknowledgement callback.
 */
export function useExcerptFocus({
  focusExcerptId,
  excerpts,
  renderExcerptChat,
  setChatOpen,
  onFocusHandled,
}) {
  const handledFocus = useRef(null);

  // Apply before paint without updating state during render. The ref also
  // prevents Strict Mode effect replay or a new callback from repeating a request.
  useLayoutEffect(() => {
    if (
      !focusExcerptId ||
      focusExcerptId === handledFocus.current ||
      !renderExcerptChat ||
      !excerpts.some((excerpt) => excerpt.id === focusExcerptId)
    ) {
      return;
    }
    handledFocus.current = focusExcerptId;
    setChatOpen(excerptNodeKey(focusExcerptId), true);
    onFocusHandled?.(focusExcerptId);
  }, [focusExcerptId, excerpts, renderExcerptChat, setChatOpen, onFocusHandled]);
}
