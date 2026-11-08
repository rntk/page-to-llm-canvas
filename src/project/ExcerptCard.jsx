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
 * @param {function(): Promise<*>} props.onDelete
 * @param {function(import('react').PointerEvent): void} [props.onDragStart]
 */
export function ExcerptCard({ excerpt, page, tabsHost, onDelete, onDragStart }) {
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

  return (
    <article
      className={`excerpt-card${page ? '' : ' is-detached'}`}
      style={{ width: EXCERPT_WIDTH, height: EXCERPT_HEIGHT }}
      data-excerpt-id={excerpt.id}
      aria-label={`Excerpt from ${pageTitle}`}
    >
      <header className="excerpt-card-header" onPointerDown={onDragStart}>
        <span className="excerpt-card-label">Excerpt</span>
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
      </header>
      <blockquote className="excerpt-card-text" data-canvas-scroll="" cite={excerpt.url}>
        {excerpt.text}
        {excerpt.truncated && <span className="excerpt-card-truncated"> [cut]</span>}
      </blockquote>
      <footer className="excerpt-card-footer">
        {(error || goError) && <span className="excerpt-card-error">{error || goError}</span>}
        <button type="button" onClick={remove} disabled={deleting}>
          Delete
        </button>
      </footer>
    </article>
  );
}
