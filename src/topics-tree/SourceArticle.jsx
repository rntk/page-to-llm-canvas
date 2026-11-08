import React from 'react';

/** Source identity stays visible beside quoted text, including articles sharing a host. */
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
      {source.url && <span className="tt-source-article__url">{source.url}</span>}
    </div>
  );
}
