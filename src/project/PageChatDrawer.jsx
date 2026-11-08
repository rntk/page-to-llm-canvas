import React, { useMemo } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { onceWithRetry } from '../utils/onceWithRetry.js';
import { ChatDrawer } from './ChatDrawer.jsx';
import { usePageChatSource } from './usePageChatSource.js';

const LIVE_PAGE_PROMPT =
  'Ask a question about this page. Its text is read from the tab when you send.';

/**
 * Chat about a page the user has not saved. Its text is read from the live tab
 * once per drawer session, on the first send, then reused for later turns.
 */
function LivePageChat({ source, tabId, capture, onEscape, chatPorts }) {
  const resolveSentences = useMemo(
    () => onceWithRetry(() => capture(tabId).then((result) => result.sentences)),
    [capture, tabId],
  );

  return (
    <ArticleChat
      recordKey={source.key}
      resolveSentences={resolveSentences}
      emptyPrompt={LIVE_PAGE_PROMPT}
      onEscape={onEscape}
      {...chatPorts}
    />
  );
}

/**
 * Per-page chat beside a tab card. A saved page shares its history, topics and
 * sentences with the chat opened on the page itself; any other page chats over
 * its live text under a URL-scoped history. Histories never mix across pages.
 *
 * @param {object} props
 * @param {{id: number, url?: string, title?: string}} props.tab
 * @param {function(number): Promise<{source: object}>} props.loadSource
 * @param {function(number): Promise<{sentences: string[]}>} props.capture
 * @param {function(): void} props.onClose
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function PageChatDrawer({ tab, loadSource, capture, onClose, chatPorts }) {
  const { status, source, error, reload } = usePageChatSource({
    tabId: tab.id,
    url: tab.url || '',
    loadSource,
  });

  let body;
  if (status === 'loading') {
    body = <p className="note page-chat-note">Loading chat…</p>;
  } else if (status === 'error') {
    body = (
      <div className="page-chat-note" role="alert">
        <p className="note">Could not open chat: {error}</p>
        <button type="button" onClick={reload}>
          Retry
        </button>
      </div>
    );
  } else if (source.kind === 'unsupported') {
    body = <p className="note page-chat-note">{source.reason}</p>;
  } else if (source.kind === 'record' && source.sentences.length === 0) {
    body = (
      <div className="page-chat-note" role="status">
        <p className="note">
          This page is still being processed. Chat opens once its text is ready.
        </p>
        <button type="button" onClick={reload}>
          Check again
        </button>
      </div>
    );
  } else if (source.kind === 'record') {
    body = (
      <ArticleChat
        key={`${source.key}\u0000${source.contentRevision || ''}`}
        recordKey={source.key}
        sentences={source.sentences}
        topics={source.topics}
        contentRevision={source.contentRevision}
        onEscape={onClose}
        {...chatPorts}
      />
    );
  } else {
    body = (
      <LivePageChat
        key={source.key}
        source={source}
        tabId={tab.id}
        capture={capture}
        onEscape={onClose}
        chatPorts={chatPorts}
      />
    );
  }

  return (
    <ChatDrawer
      label={status === 'ready' && source.kind === 'record' ? 'Saved page chat' : 'Page chat'}
      ariaLabel={`Chat about ${tab.title || tab.url || 'this page'}`}
    >
      {body}
    </ChatDrawer>
  );
}
