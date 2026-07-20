import React from 'react';

/**
 * The original article HTML, re-rendered onto the canvas sheet. Sentence
 * highlighting and rail measurement work off live DOM Ranges built over this
 * subtree (see sentenceHighlight.js) rather than per-sentence spans, so the
 * markup can stay structurally identical to the source for readability.
 *
 * @param {{ html: string, articleTextRef: import('react').Ref<HTMLDivElement> }} props
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
