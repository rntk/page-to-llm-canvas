import React, { useEffect, useRef } from 'react';

/**
 * Scrolling transcript of visible chat messages plus the loading row.
 *
 * @param {object} props
 * @param {object[]} props.messages
 * @param {boolean} props.isLoading
 * @param {boolean} props.isLoadingHistory
 * @param {string} [props.emptyPrompt]
 */
function ChatMessageList({
  messages,
  isLoading,
  isLoadingHistory,
  emptyPrompt = 'Ask a question about this article.',
}) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ behavior: 'smooth' });
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

export default React.memo(ChatMessageList);
