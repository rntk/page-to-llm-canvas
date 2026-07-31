import React from 'react';
import { formatTimestampLabel } from '../utils/youtubeTimestamp.js';
import { eventRange } from './useChatSessions.js';

/**
 * Read-only list of highlight events for the active chat. Events can be
 * selected to revisit their evidence, but are retained for the chat's life.
 *
 * @param {object} props
 * @param {object[]} props.events
 * @param {?number} props.selectedEventSeq
 * @param {function(object): void} props.onSelectEvent
 * @param {'article' | 'video'} [props.subject]
 * @param {function(object): ?number} [props.getEventTimestamp]
 * @param {boolean} [props.disabled]
 */
export default function ChatEventsList({
  events,
  selectedEventSeq,
  onSelectEvent,
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
          </div>
        );
      })}
    </div>
  );
}
