import React from 'react';

/**
 * Temporary, unsaved card showing the passage a chat event cites, unfolded
 * under its chat drawer. Styled as an excerpt card.
 *
 * @param {object} props
 * @param {{label: string, startLine: number, endLine: number, sentences?: string[], error?: string}} props.passage
 * @param {string} props.sourceName What the lines belong to ("this page", ...).
 * @param {function(): void} props.onClose
 */
export function ChatPassageCard({ passage, sourceName, onClose }) {
  const { label, startLine, endLine, sentences, error } = passage;
  const lines = startLine === endLine ? `Line ${startLine}` : `Lines ${startLine}–${endLine}`;
  return (
    <article
      className="excerpt-card chat-passage-card"
      aria-label={`Chat evidence from ${sourceName}`}
      aria-live="polite"
    >
      <header className="excerpt-card-header">
        <span className="excerpt-card-label">Evidence</span>
        <span className="chat-passage-card-title" title={label || lines}>
          {label ? `${label} · ${lines}` : lines}
        </span>
        <button
          type="button"
          className="chat-passage-card-close"
          onClick={onClose}
          aria-label="Close evidence"
          title="Close evidence"
        >
          ×
        </button>
      </header>
      {error ? (
        <p className="note chat-passage-card-error" role="alert">
          {error}
        </p>
      ) : (
        <blockquote className="excerpt-card-text" data-canvas-scroll="">
          {sentences.join(' ')}
        </blockquote>
      )}
    </article>
  );
}
