// Helpers for re-rendering a record's stored article HTML inside the canvas
// modal. Kept separate from App.jsx so they stay plain functions (testable,
// and friendly to React Fast Refresh).

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text) {
  return String(text || '').replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPES[c]);
}

/**
 * Re-render the original article markup as faithfully as possible while removing
 * anything that could execute or fetch in the modal iframe. The page's CSP
 * (`script-src 'self'`) already blocks inline handlers and remote scripts; this
 * is defence in depth so the choice to inject stored remote HTML is explicit.
 * Inline `style` attributes are kept so the article keeps its original look.
 */
export function sanitizeArticleHtml(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc
      .querySelectorAll('script, style, noscript, iframe, object, embed, link, meta, base')
      .forEach((el) => el.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if (
          (name === 'href' || name === 'src' || name === 'xlink:href') &&
          /^\s*javascript:/i.test(attr.value)
        ) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return doc.body.innerHTML;
  } catch (_) {
    return '';
  }
}
