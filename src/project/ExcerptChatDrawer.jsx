import React, { useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createPageTools } from '../chat/readPageTool.js';
import { excerptChatKey } from '../core/storage/keys.js';
import { excerptSentences } from './excerptText.js';

const NO_TOPICS = [];
const EXCERPT_PROMPT =
  'Ask about this excerpt. The assistant can read the rest of the page when the excerpt is not enough.';

/**
 * The excerpt's own chat, beside its card. Turns send the excerpt (framed as
 * part of its page) and offer `read_page` and `search_page` tools; the page is read at most once
 * per drawer session, on the first call that needs it.
 *
 * @param {object} props
 * @param {{id: string, url: string, title?: string, text: string}} props.excerpt
 * @param {function(string): Promise<{sentences: string[], truncated?: boolean}>} props.readPage
 * @param {function(): void} props.onClose
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function ExcerptChatDrawer({ excerpt, readPage, onClose, chatPorts }) {
  const { id, text, title, url } = excerpt;
  const sentences = useMemo(() => excerptSentences(text), [text]);
  const source = useMemo(
    () => ({ kind: 'excerpt', pageTitle: title || '', pageUrl: url }),
    [title, url],
  );
  const tools = useMemo(() => {
    let page = null;
    const loadPage = () => {
      page ??= readPage(id).catch((err) => {
        // Let a later call try again (e.g. after the tab finishes loading).
        page = null;
        throw err;
      });
      return page;
    };
    return createPageTools({ excerptSentences: sentences, loadPage });
  }, [readPage, id, sentences]);

  return (
    <aside className="page-chat-drawer" aria-label={`Chat about the excerpt from ${title || url}`}>
      <header className="page-chat-header">
        <span className="page-chat-label">Excerpt chat</span>
      </header>
      <div className="page-chat-body">
        <ArticleChat
          recordKey={excerptChatKey(id)}
          sentences={sentences}
          topics={NO_TOPICS}
          source={source}
          tools={tools}
          emptyPrompt={EXCERPT_PROMPT}
          onEscape={onClose}
          {...chatPorts}
        />
      </div>
    </aside>
  );
}
