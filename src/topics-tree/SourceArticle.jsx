import React from 'react';

/** Show the title and full URL so articles on the same host stay distinguishable. */
export default function SourceArticle({ source }) {
  let href;
  try {
    const parsed = new URL(source.url);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') href = parsed.href;
  } catch (_error) {
    // Imported records can have incomplete URLs; keep the attribution as text.
  }
  const title = source.title || source.url || 'Unknown source';
  return (
    <div className="tt-source-article">
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => event.stopPropagation()}
        >
          {title}
        </a>
      ) : (
        <strong>{title}</strong>
      )}
      {source.url && (
        <span className="tt-source-article__url" title={source.url}>
          {source.url}
        </span>
      )}
    </div>
  );
}
