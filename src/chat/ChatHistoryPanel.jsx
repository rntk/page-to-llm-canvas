import React from 'react';

function formatDate(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
}

/**
 * Dropdown list of stored chats with per-chat delete.
 *
 * @param {object} props
 * @param {object[]} props.chats
 * @param {?string} props.activeChatId
 * @param {function(string): void} props.onSelectChat
 * @param {function(string): void} props.onDeleteChat
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.deleteDisabled]
 */
export default function ChatHistoryPanel({
  chats,
  activeChatId,
  onSelectChat,
  onDeleteChat,
  disabled = false,
  deleteDisabled = disabled,
}) {
  return (
    <div className="pagetollm-chat-history-panel">
      {chats.length === 0 ? <div className="pagetollm-chat-empty">No chats yet.</div> : null}
      {chats.map((chat) => (
        <div
          key={chat.chatId}
          className={`pagetollm-chat-history-item${chat.chatId === activeChatId ? ' is-active' : ''}`}
        >
          <button type="button" onClick={() => onSelectChat(chat.chatId)} disabled={disabled}>
            <strong>{chat.title || 'New chat'}</strong>
            <span>
              {formatDate(chat.updatedAt)} · {chat.messageCount} msg · {chat.eventCount} ev
            </span>
          </button>
          <button
            type="button"
            className="is-delete"
            onClick={() => onDeleteChat(chat.chatId)}
            disabled={deleteDisabled}
            aria-label={`Delete ${chat.title || 'chat'}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
