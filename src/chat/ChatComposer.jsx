import React, { useCallback, useId } from 'react';

/**
 * Question textarea plus Send button. Enter sends; Shift+Enter inserts a
 * newline.
 *
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   onSend: () => void,
 *   disabled: boolean,
 *   placeholder?: string,
 * }} props
 */
export default function ChatComposer({
  value,
  onChange,
  onSend,
  disabled,
  placeholder = 'Ask about this article…',
}) {
  const messageId = useId();
  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        onSend();
      }
    },
    [onSend],
  );

  return (
    <div className="pagetollm-chat-composer">
      <div className="pagetollm-chat-composer-field">
        <label htmlFor={messageId}>Message</label>
        <textarea
          id={messageId}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
        />
      </div>
      <button type="button" onClick={onSend} disabled={!value.trim() || disabled}>
        Send
      </button>
    </div>
  );
}
