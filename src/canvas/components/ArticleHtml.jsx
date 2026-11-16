import React from 'react';

/**
 * The original article HTML on the canvas sheet. Highlighting and measurement use
 * DOM Ranges over this subtree (see sentenceHighlight.js), not per-sentence spans,
 * so the markup stays identical to the source.
 *
 * @param {object} props
 * @param {string} props.html
 * @param {object} props.articleTextRef
 */
const ArticleHtml = React.memo(function ArticleHtml({ html, articleTextRef }) {
  return (
    <div
      className="pagetollm-article-text pagetollm-article-html"
      ref={articleTextRef}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

export default ArticleHtml;
