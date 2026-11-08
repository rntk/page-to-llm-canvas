import React, { useCallback, useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createMultiPageTools, createPageTools } from '../chat/readPageTool.js';

const NO_TOPICS = [];
const CARD_PROMPT =
  'Ask about this source text. The assistant can read and search the rest of the article when the card is not enough.';
const BLOCK_PROMPT =
  'Ask about the text of this topic. The sections come from different sub-topics and pages, and the assistant can read and search the pages beyond them.';

/**
 * The chat of one source card, or of a topic's whole source text, unfolded
 * beside it. A turn sends the card's lines (framed as part of their article, or
 * as sections of several) and offers `read_page` and `search_page` over the
 * whole article(s), already in memory.
 *
 * @param {object} props
 * @param {import('./sourceCardChat.js').SourceCardChat|import('./sourceCardChat.js').SourceBlockChat} props.card
 * @param {function(): void} props.onClose
 * @param {function(string[], {focus: boolean}): void} [props.onHighlightLines]
 *   Receives the passage keys of a highlighted span of the chat's lines.
 * @param {function(): void} [props.onClearHighlights]
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function SourceCardChatDrawer({
  card,
  onClose,
  onHighlightLines,
  onClearHighlights,
  chatPorts,
}) {
  const { chatKey, contentRevision, cardSentences, lineKeys } = card;
  const pages = card.pages || null;
  const title = pages ? card.topic || 'this topic' : card.title;
  const url = card.url;
  const source = useMemo(
    () =>
      pages
        ? { kind: 'sections', topic: card.topic, pages }
        : { kind: 'excerpt', pageTitle: title, pageUrl: url },
    [pages, card.topic, title, url],
  );
  const tools = useMemo(() => {
    if (pages) {
      return createMultiPageTools(
        pages.map((page) => ({
          excerptSentences: page.excerptSentences,
          loadPage: async () => ({ sentences: page.pageSentences }),
        })),
      );
    }
    return createPageTools({
      excerptSentences: cardSentences,
      loadPage: async () => ({ sentences: card.pageSentences }),
    });
  }, [pages, cardSentences, card.pageSentences]);

  // Chat lines are 1-based positions in cardSentences; the card shows them as passages.
  const onHighlight = useCallback(
    ({ startLine, endLine }, { focus = false } = {}) => {
      const keys = (lineKeys || []).slice(startLine - 1, endLine).filter(Boolean);
      onHighlightLines?.(keys, { focus });
    },
    [lineKeys, onHighlightLines],
  );

  return (
    <aside
      className="tt-card__chat"
      aria-label={
        pages
          ? `Chat about the source text of ${title}`
          : `Chat about the source text from ${title || url || 'this article'}`
      }
    >
      <header className="tt-card__chat-head">Source chat</header>
      <div className="tt-card__chat-body">
        <ArticleChat
          key={`${chatKey}\u0000${contentRevision || ''}`}
          recordKey={chatKey}
          sentences={cardSentences}
          topics={NO_TOPICS}
          contentRevision={contentRevision}
          source={source}
          tools={tools}
          emptyPrompt={pages ? BLOCK_PROMPT : CARD_PROMPT}
          onEscape={onClose}
          onHighlight={onHighlightLines ? onHighlight : undefined}
          onClearHighlights={onClearHighlights}
          {...chatPorts}
        />
      </div>
    </aside>
  );
}
