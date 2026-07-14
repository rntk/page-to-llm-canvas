import React from 'react';
import { formatTimestampLabel } from '../utils/youtubeTimestamp.js';
import { eventRange } from './useChatSessions.js';

/**
 * List of highlight events for the active chat, with select and delete.
 *
 * @param {{
 *   events: object[],
 *   selectedEventSeq: number | null,
 *   onSelectEvent: (event: object) => void,
 *   onDeleteEvent: (event: object) => void,
 *   subject?: 'article' | 'video',
 *   getEventTimestamp?: (range: object) => number | null,
 *   disabled?: boolean,
 * }} props
 */
export default function ChatEventsList({
  events,
  selectedEventSeq,
  onSelectEvent,
  onDeleteEvent,
  subject = 'article',
  getEventTimestamp,
  disabled = false,
}) {
  const isVideo = subject === 'video';

  return (
    <div className="pagetollm-chat-events" role="list">
      {events.length === 0 ? (
        <div className="pagetollm-chat-empty">No events in this chat.</div>
      ) : null}
      {events.map((event, index) => {
        const range = eventRange(event);
        const seconds = isVideo && range ? getEventTimestamp?.(range) : null;
        const hasTimestamp = Number.isFinite(seconds);
        const isUnavailable = isVideo && !hasTimestamp;
        const eventLabel = range?.label || (isVideo ? 'Video evidence' : 'Highlight');
        const detail = isVideo
          ? `${hasTimestamp ? `Jump to ${formatTimestampLabel(seconds)}` : 'Timestamp unavailable'} · Transcript lines ${range?.startLine ?? '?'}–${range?.endLine ?? '?'}`
          : `Highlight · Lines ${range?.startLine ?? '?'}–${range?.endLine ?? '?'}`;
        return (
          <div
            key={event.seq}
            className={`pagetollm-chat-event${event.seq === selectedEventSeq ? ' is-active' : ''}`}
            role="listitem"
          >
            <button
              type="button"
              onClick={() => onSelectEvent(event)}
              disabled={disabled || isUnavailable}
              title={
                isUnavailable
                  ? 'This evidence has no transcript timestamp, so the video cannot jump to it.'
                  : isVideo
                    ? `Jump video to ${formatTimestampLabel(seconds)}`
                    : undefined
              }
            >
              <strong>
                #{index + 1} {eventLabel}
              </strong>
              <span>{detail}</span>
            </button>
            <button
              type="button"
              className="is-delete"
              onClick={() => onDeleteEvent(event)}
              disabled={disabled}
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
