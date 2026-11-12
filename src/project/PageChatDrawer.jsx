import React, { useCallback, useMemo, useState } from 'react';
import ArticleChat from '../chat/ArticleChat.jsx';
import { onceWithRetry } from '../utils/onceWithRetry.js';
import { ChatDrawer } from './ChatDrawer.jsx';
import { ChatPassageCard } from './ChatPassageCard.jsx';
import { useChatPassage } from './useChatPassage.js';
import { usePageChatSource } from './usePageChatSource.js';

const LIVE_PAGE_PROMPT =
  'Ask a question about this page. Its text is read from the tab when you send.';
const NO_SENTENCES = [];

/**
 * Per-page chat beside a tab card. A saved page shares its history, topics and
 * sentences with the chat opened on the page itself; any other page chats over
 * its live text under a URL-scoped history, read from the tab once per drawer
 * session (on the first send) and reused for later turns. Histories never mix
 * across pages. Picking a chat event unfolds its cited passage under the drawer.
 *
 * @param {object} props
 * @param {string} [props.drawerId] The drawer element id.
 * @param {{id: number, url?: string, title?: string}} props.tab
 * @param {function(number): Promise<{source: object}>} props.loadSource
 * @param {function(number): Promise<{sentences: string[]}>} props.capture
 * @param {function(): void} props.onClose
 * @param {{chatRepository?: object, runTurn?: Function, getChatLimits?: Function}} [props.chatPorts]
 *   ArticleChat port overrides (tests); the browser defaults apply otherwise.
 */
export function PageChatDrawer({ drawerId, tab, loadSource, capture, onClose, chatPorts }) {
  // The chat's History/New actions share the drawer header row (see ChatDrawer).
  const [actionsTarget, setActionsTarget] = useState(null);
  const { status, source, error, reload } = usePageChatSource({
    tabId: tab.id,
    url: tab.url || '',
    loadSource,
  });

  const isRecord = status === 'ready' && source.kind === 'record';
  const isLive = status === 'ready' && source.kind !== 'record' && source.kind !== 'unsupported';
  const liveKey = isLive ? source.key : null;
  // One read per live page, shared by the chat's turns and the passage card.
  const resolveLiveSentences = useMemo(
    () =>
      liveKey === null
        ? null
        : onceWithRetry(() => capture(tab.id).then((result) => result.sentences)),
    [capture, tab.id, liveKey],
  );
  const recordSentences = isRecord ? source.sentences : NO_SENTENCES;
  const getSentences = useCallback(
    () => (resolveLiveSentences ? resolveLiveSentences() : recordSentences),
    [resolveLiveSentences, recordSentences],
  );
  const { passage, onHighlight, onClearHighlights } = useChatPassage(getSentences);

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
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
        onEscape={onClose}
        headerActionsTarget={actionsTarget}
        {...chatPorts}
      />
    );
  } else {
    body = (
      <ArticleChat
        key={source.key}
        recordKey={source.key}
        resolveSentences={resolveLiveSentences}
        emptyPrompt={LIVE_PAGE_PROMPT}
        onHighlight={onHighlight}
        onClearHighlights={onClearHighlights}
        onEscape={onClose}
        headerActionsTarget={actionsTarget}
        {...chatPorts}
      />
    );
  }

  return (
    <ChatDrawer
      id={drawerId}
      actionsRef={setActionsTarget}
      label={isRecord ? 'Saved page chat' : 'Page chat'}
      ariaLabel={`Chat about ${tab.title || tab.url || 'this page'}`}
      below={
        passage && (
          <ChatPassageCard passage={passage} sourceName="this page" onClose={onClearHighlights} />
        )
      }
    >
      {body}
    </ChatDrawer>
  );
}
