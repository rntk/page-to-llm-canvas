import React, { useMemo, useState } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { createPageTools } from '../chat/readPageTool.js';
import { excerptChatKey } from '../core/storage/keys.js';
import { onceWithRetry } from '../utils/onceWithRetry.js';
import { ChatDrawer } from './ChatDrawer.jsx';
import { excerptSentences } from './excerptText.js';

const EXCERPT_PROMPT =
  'Ask about this excerpt. The assistant can read the rest of the page when the excerpt is not enough.';

/**
 * The excerpt's own chat, beside its card. Turns send the excerpt (framed as
 * part of its page) and offer `read_page` and `search_page` tools; the page is read at most once
 * per drawer session, on the first call that needs it.
 *
 * @param {object} props
 * @param {string} [props.drawerId] The drawer element id.
 * @param {{id: string, url: string, title?: string, text: string}} props.excerpt
 * @param {function(string): Promise<{sentences: string[], truncated?: boolean}>} props.readPage
 * @param {function(): void} props.onClose
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function ExcerptChatDrawer({ drawerId, excerpt, readPage, onClose, chatPorts }) {
  // The chat's History/New actions share the drawer header row (see ChatDrawer).
  const [actionsTarget, setActionsTarget] = useState(null);
  const { id, text, title, url } = excerpt;
  const sentences = useMemo(() => excerptSentences(text), [text]);
  const source = useMemo(
    () => ({ kind: 'excerpt', pageTitle: title || '', pageUrl: url }),
    [title, url],
  );
  const tools = useMemo(
    () =>
      createPageTools({
        excerptSentences: sentences,
        loadPage: onceWithRetry(() => readPage(id)),
      }),
    [readPage, id, sentences],
  );

  return (
    <ChatDrawer
      id={drawerId}
      actionsRef={setActionsTarget}
      label="Excerpt chat"
      ariaLabel={`Chat about the excerpt from ${title || url}`}
    >
      <ArticleChat
        recordKey={excerptChatKey(id)}
        sentences={sentences}
        source={source}
        tools={tools}
        emptyPrompt={EXCERPT_PROMPT}
        onEscape={onClose}
        headerActionsTarget={actionsTarget}
        {...chatPorts}
      />
    </ChatDrawer>
  );
}
