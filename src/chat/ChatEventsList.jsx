import React from 'react';
import { eventRange } from './useChatSessions.js';

/**
 * List of highlight events for the active chat, with select and delete.
 *
 * @param {{
 *   events: object[],
 *   selectedEventSeq: number | null,
 *   onSelectEvent: (event: object) => void,
 *   onDeleteEvent: (event: object) => void,
 * }} props
 */
export default function ChatEventsList({ events, selectedEventSeq, onSelectEvent, onDeleteEvent }) {
  return (
    <div className="pagetollm-chat-events" role="list">
      {events.length === 0 ? (
        <div className="pagetollm-chat-empty">No events in this chat.</div>
      ) : null}
      {events.map((event, index) => {
        const range = eventRange(event);
        return (
          <div
            key={event.seq}
            className={`pagetollm-chat-event${event.seq === selectedEventSeq ? ' is-active' : ''}`}
            role="listitem"
          >
            <button type="button" onClick={() => onSelectEvent(event)}>
              <strong>#{index + 1} Highlight</strong>
              <span>
                Lines {range?.startLine ?? '?'}–{range?.endLine ?? '?'}
                {range?.label ? ` · ${range.label}` : ''}
              </span>
            </button>
            <button
              type="button"
              className="is-delete"
              onClick={() => onDeleteEvent(event)}
              aria-label={`Delete event ${index + 1}`}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
