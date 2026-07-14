import React, { useEffect, useRef } from 'react';

/**
 * Scrolling transcript of visible chat messages plus the loading row.
 *
 * @param {{
 *   messages: object[],
 *   isLoading: boolean,
 *   isLoadingHistory: boolean,
 * }} props
 */
export default function ChatMessageList({ messages, isLoading, isLoadingHistory }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages, isLoading]);

  return (
    <div className="pagetollm-chat-history" aria-live="polite">
      {messages.length === 0 ? (
        <div className="pagetollm-chat-empty">Ask a question about this article.</div>
      ) : null}
      {messages.map((message, index) => (
        <div
          key={message.id || `${message.role}-${index}`}
          className={`pagetollm-chat-message is-${message.role}`}
        >
          <strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong>
          <span>{message.content}</span>
        </div>
      ))}
      {isLoading || isLoadingHistory ? (
        <div className="pagetollm-chat-message is-assistant is-loading">
          <strong>Assistant</strong>
          <span>{isLoading ? 'Thinking…' : 'Loading history…'}</span>
        </div>
      ) : null}
      <div ref={endRef} />
    </div>
  );
}
