import React, { useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createPageTools } from '../chat/readPageTool.js';

const NO_TOPICS = [];
const CARD_PROMPT =
  'Ask about this source text. The assistant can read and search the rest of the article when the card is not enough.';

/**
 * The chat of one source card, unfolded beside it. A turn sends the card's
 * lines (framed as part of their article) and offers `read_page` and
 * `search_page` over the whole article, which is already in memory.
 *
 * @param {object} props
 * @param {import('./sourceCardChat.js').SourceCardChat} props.card
 * @param {function(): void} props.onClose
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function SourceCardChatDrawer({ card, onClose, chatPorts }) {
  const { chatKey, title, url, contentRevision, cardSentences, pageSentences } = card;
  const source = useMemo(() => ({ kind: 'excerpt', pageTitle: title, pageUrl: url }), [title, url]);
  const tools = useMemo(
    () =>
      createPageTools({
        excerptSentences: cardSentences,
        loadPage: async () => ({ sentences: pageSentences }),
      }),
    [cardSentences, pageSentences],
  );

  return (
    <aside
      className="tt-card__chat"
      aria-label={`Chat about the source text from ${title || url || 'this article'}`}
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
          emptyPrompt={CARD_PROMPT}
          onEscape={onClose}
          {...chatPorts}
        />
      </div>
    </aside>
  );
}
