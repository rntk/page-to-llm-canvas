/**
 * DOM-side adapter for the in-page rail, extracted from openInPageRail in
 * src/content/rails/in-page/controller.jsx.
 *
 * Owns everything that touches the live page: the two CSS Custom Highlight
 * sets, the DOM Ranges they are painted from, smooth scrolling into the
 * article, and the coalesced viewport-resize listener.
 *
 * Deliberately guard-free: staleness (`guard.isStale()`) and surface lifetime
 * (`isClosed()`) stay in the controller, which is the only place that knows
 * about load generations.
 */

import {
  HIGHLIGHT_NAME,
  CHAT_HIGHLIGHT_NAME,
  supportsHighlightApi,
  buildSentenceDomRange,
  paintSentenceHighlight,
} from '../../../highlights/sentenceHighlight.js';

/**
 * @param {object} opts
 * @param {Array} opts.wordEntries Word entries collected from the picked elements.
 * @param {Map|object} opts.sentenceRanges Sentence-number → word-range index.
 * @param {Window|Element|null} opts.scrollContainer Scroller the article lives in.
 * @param {Window} opts.window Content window (scroll + resize target).
 * @returns {object} highlighter adapter
 */
export function createPageHighlighter({
  wordEntries,
  sentenceRanges,
  scrollContainer,
  window: contentWindow = globalThis.window,
}) {
  // Native CSS Custom Highlight API: topic and chat sentences are painted as
  // two separate named highlights (mirrors the canvas modal), so chat
  // highlights stay visually distinct via ::highlight(pagetollm-chat-sentence)
  // instead of being merged into the topic highlight. Unlike per-word spans, a
  // single Range per sentence paints continuously across whitespace and inline
  // tags, so there are no gaps between words.
  const activeTopicSentences = new Set();
  const activeChatSentences = new Set();

  let resizeFrameId = 0;
  let detachResize = null;

  function rebuild(name, activeSentences) {
    if (!supportsHighlightApi()) return;
    paintSentenceHighlight(name, activeSentences, {
      wordEntries,
      sentenceRanges,
    });
  }

  function clearAll() {
    activeTopicSentences.clear();
    activeChatSentences.clear();
    rebuild(HIGHLIGHT_NAME, activeTopicSentences);
    rebuild(CHAT_HIGHLIGHT_NAME, activeChatSentences);
  }

  /**
   * Replace stale DOM references while preserving the requested highlights.
   * @param {object} anchors Fresh word entries, sentence ranges, and scroller.
   */
  function updateAnchors(anchors) {
    wordEntries = anchors.wordEntries;
    sentenceRanges = anchors.sentenceRanges;
    scrollContainer = anchors.scrollContainer;
    rebuild(HIGHLIGHT_NAME, activeTopicSentences);
    rebuild(CHAT_HIGHLIGHT_NAME, activeChatSentences);
  }

  function highlightTopic(sentenceList, on) {
    for (const sNum of sentenceList) {
      if (on) activeTopicSentences.add(sNum);
      else activeTopicSentences.delete(sNum);
    }
    rebuild(HIGHLIGHT_NAME, activeTopicSentences);
  }

  function highlightChatRange(startLine, endLine) {
    for (let line = startLine; line <= endLine; line += 1) {
      activeChatSentences.add(line);
    }
    rebuild(CHAT_HIGHLIGHT_NAME, activeChatSentences);
  }

  function clearChatHighlights() {
    activeChatSentences.clear();
    rebuild(CHAT_HIGHLIGHT_NAME, activeChatSentences);
  }

  function scrollToFirst(sentenceList) {
    if (!sentenceList || !sentenceList.length) return;
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceList[0]);
    if (!domRange) return;
    const rect = domRange.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    if (scrollContainer && scrollContainer !== contentWindow) {
      const cRect = scrollContainer.getBoundingClientRect();
      const delta = rect.top - cRect.top - scrollContainer.clientHeight / 2;
      scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: 'smooth' });
    } else {
      const targetY = rect.top + contentWindow.scrollY - contentWindow.innerHeight / 2;
      contentWindow.scrollTo({ top: targetY, behavior: 'smooth' });
    }
  }

  /**
   * Subscribe to viewport resizes, coalesced into one animation frame. Only one
   * subscription is kept; `destroy()` detaches it.
   *
   * @param {function(): void} callback Invoked inside the animation frame.
   */
  function onViewportResize(callback) {
    detachResize?.();
    const handleViewportResize = () => {
      if (resizeFrameId) return;
      resizeFrameId = requestAnimationFrame(() => {
        resizeFrameId = 0;
        callback();
      });
    };
    contentWindow.addEventListener('resize', handleViewportResize);
    detachResize = () => {
      detachResize = null;
      if (resizeFrameId) cancelAnimationFrame(resizeFrameId);
      resizeFrameId = 0;
      contentWindow.removeEventListener('resize', handleViewportResize);
    };
  }

  function destroy() {
    detachResize?.();
    if (supportsHighlightApi()) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      CSS.highlights.delete(CHAT_HIGHLIGHT_NAME);
    }
  }

  return {
    updateAnchors,
    highlightTopic,
    highlightChatRange,
    clearChatHighlights,
    clearAll,
    scrollToFirst,
    onViewportResize,
    destroy,
  };
}
