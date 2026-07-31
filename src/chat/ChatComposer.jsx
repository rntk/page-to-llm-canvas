import React, { useCallback, useId } from 'react';

/**
 * Question textarea plus Send button. Enter sends; Shift+Enter inserts a
 * newline.
 *
 * @param {object} props
 * @param {string} props.value
 * @param {function(string): void} props.onChange
 * @param {function(): void} props.onSend
 * @param {function(): void} [props.onStop]
 * @param {boolean} [props.isLoading]
 * @param {boolean} props.disabled
 * @param {string} [props.placeholder]
 */
export default function ChatComposer({
  value,
  onChange,
  onSend,
  onStop,
  isLoading = false,
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
        <textarea
          id={messageId}
          aria-label="Message"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
        />
      </div>
      {isLoading ? (
        <button className="pagetollm-chat-stop" type="button" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button type="button" onClick={onSend} disabled={!value.trim() || disabled}>
          Send
        </button>
      )}
    </div>
  );
}
