import React, { useState } from 'react';
import { EXCERPT_HEIGHT, EXCERPT_WIDTH } from './canvasLayout.js';
import { hostnameOf } from './projectText.js';
import { useActivateTab } from './useActivateTab.js';

/**
 * Card for one excerpt: the selected passage and a link naming the page it was
 * taken from. The excerpt chat unfolds beside it (see ProjectCanvas).
 *
 * @param {object} props
 * @param {{id: string, url: string, title?: string, text: string, truncated?: boolean}} props.excerpt
 * @param {{id: number, title?: string}|null} props.page The open tab showing the
 *   excerpt's page, or null when that page is not in the project.
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 * @param {function(): Promise<*>} [props.onDelete] Offers Delete (saved excerpts).
 * @param {boolean} [props.evidence] An unsaved project chat evidence card: the
 *   `excerpt` is a ChatEvidence (see useChatEvidence), labelled with its chat
 *   tag and page lines instead of a Delete button, and closed with `onClose`.
 * @param {function(): void} [props.onClose] Closes an evidence card.
 * @param {function(import('react').PointerEvent): void} [props.onDragStart]
 */
export function ExcerptCard({
  excerpt,
  page,
  tabsHost,
  onDelete,
  onDragStart,
  evidence = false,
  onClose,
}) {
  const { go, error: goError, clearError } = useActivateTab(tabsHost);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const pageTitle = page?.title || excerpt.title || excerpt.url;

  const goToPage = () => {
    if (!page) return;
    setError('');
    go(page.id);
  };

  const remove = () => {
    clearError();
    setError('');
    setDeleting(true);
    Promise.resolve()
      .then(onDelete)
      .catch(() => {
        setDeleting(false);
        setError('Could not delete excerpt');
      });
  };

  const lines = evidence
    ? excerpt.startLine === excerpt.endLine
      ? `Line ${excerpt.startLine}`
      : `Lines ${excerpt.startLine}–${excerpt.endLine}`
    : '';
  const classes = [
    'excerpt-card',
    page ? '' : 'is-detached',
    evidence ? 'is-chat-evidence' : '',
  ].filter(Boolean);

  return (
    <article
      className={classes.join(' ')}
      style={{ width: EXCERPT_WIDTH, height: EXCERPT_HEIGHT }}
      data-excerpt-id={excerpt.id}
      aria-label={`${evidence ? 'Chat evidence' : 'Excerpt'} from ${pageTitle}`}
    >
      <header className="excerpt-card-header" onPointerDown={onDragStart}>
        <span className="excerpt-card-label">{evidence ? 'Chat evidence' : 'Excerpt'}</span>
        <button
          type="button"
          className="excerpt-card-source"
          title={page ? `Go to tab: ${excerpt.url}` : `${excerpt.url} (not open in this project)`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={goToPage}
          disabled={!page}
        >
          <span aria-hidden="true">↖ </span>
          <span className="excerpt-card-source-title">{pageTitle}</span>
          {!page && <span className="excerpt-card-source-host"> · {hostnameOf(excerpt.url)}</span>}
        </button>
        {evidence && onClose && (
          <button
            type="button"
            className="chat-passage-card-close"
            aria-label="Close chat evidence"
            title="Close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </header>
      {evidence && (excerpt.loading || excerpt.error) ? (
        <p className="note excerpt-card-text" role={excerpt.error ? 'alert' : 'status'}>
          {excerpt.error || 'Reading the page…'}
        </p>
      ) : (
        <blockquote className="excerpt-card-text" data-canvas-scroll="" cite={excerpt.url}>
          {excerpt.text}
          {excerpt.truncated && <span className="excerpt-card-truncated"> [cut]</span>}
        </blockquote>
      )}
      <footer className="excerpt-card-footer">
        {(error || goError) && (
          <span className="excerpt-card-error" title={error || goError}>
            {error || goError}
          </span>
        )}
        {evidence ? (
          <span className="excerpt-card-lines" title={excerpt.label || lines}>
            {excerpt.label ? `${excerpt.label} · ${lines}` : lines}
          </span>
        ) : (
          onDelete && (
            <button type="button" onClick={remove} disabled={deleting}>
              Delete
            </button>
          )
        )}
      </footer>
    </article>
  );
}
