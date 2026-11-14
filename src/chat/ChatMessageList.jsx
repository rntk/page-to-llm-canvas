import React, { useEffect, useRef } from 'react';
import { scrollBehavior } from '../utils/scrollBehavior.js';
import ChatToolLog from './ChatToolLog.jsx';

/**
 * Scrolling transcript of visible chat messages plus the loading row.
 * Assistant messages with a `toolLog` show a foldable list of called tools.
 *
 * @param {object} props
 * @param {object[]} props.messages
 * @param {boolean} props.isLoading
 * @param {boolean} props.isLoadingHistory
 * @param {object[]} [props.liveToolLog] Tools called so far by the running turn.
 * @param {string} [props.emptyPrompt]
 */
function ChatMessageList({
  messages,
  isLoading,
  isLoadingHistory,
  liveToolLog,
  emptyPrompt = 'Ask a question about this article.',
}) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: scrollBehavior() });
  }, [messages, isLoading]);

  return (
    <div className="pagetollm-chat-history" aria-live="polite">
      {messages.length === 0 ? <div className="pagetollm-chat-empty">{emptyPrompt}</div> : null}
      {messages.map((message, index) => (
        <div
          key={message.id || `${message.role}-${index}`}
          className={`pagetollm-chat-message is-${message.role}`}
        >
          <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
          {message.role === 'assistant' ? <ChatToolLog entries={message.toolLog} /> : null}
          <span>{message.content}</span>
        </div>
      ))}
      {isLoading || isLoadingHistory ? (
        <div className="pagetollm-chat-message is-assistant is-loading">
          <strong>Assistant</strong>
          {isLoading ? <ChatToolLog entries={liveToolLog} live /> : null}
          <span>{isLoading ? 'Thinking…' : 'Loading history…'}</span>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}

export default React.memo(ChatMessageList);
