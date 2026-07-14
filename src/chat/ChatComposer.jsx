import React, { useCallback } from 'react';

/**
 * Question textarea plus Send button. Enter sends; Shift+Enter inserts a
 * newline.
 *
 * @param {{
 *   value: string,
 *   onChange: (value: string) => void,
 *   onSend: () => void,
 *   disabled: boolean,
 * }} props
 */
export default function ChatComposer({ value, onChange, onSend, disabled }) {
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
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask about this article…"
        rows={3}
        disabled={disabled}
        aria-label="Message"
      />
      <button type="button" onClick={onSend} disabled={!value.trim() || disabled}>
        Send
      </button>
    </div>
  );
}
