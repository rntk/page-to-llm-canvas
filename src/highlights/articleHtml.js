// Helpers for re-rendering a record's stored article HTML inside the canvas
// modal. Kept separate from App.jsx so they stay plain functions (testable,
// and friendly to React Fast Refresh).

/**
 * Re-render the original article markup as faithfully as possible while removing
 * anything that could execute in the extension page. CSP blocks scripts,
 * plugins, framing and form submission; this is defence in depth so the choice
 * to inject stored remote HTML is explicit. Inline `style` attributes and
 * remote `<img>` sources are kept so the article keeps its original look —
 * `img-src` allows `https:` for exactly that reason, which means opening a
 * record does issue image requests to the original host.
 * @param {string} html Stored article HTML.
 */
export function sanitizeArticleHtml(html) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc
      .querySelectorAll('script, style, noscript, iframe, object, embed, link, meta, base')
      .forEach((el) => el.remove());
    // Forms can wrap article content, so unwrap them rather than dropping the
    // subtree. Submission is already dead: the CSP sets `form-action 'none'`
    // and the attribute pass below strips `action`/`formaction`.
    doc.querySelectorAll('form').forEach((el) => el.replaceWith(...el.childNodes));
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
          el.removeAttribute(attr.name);
        } else if (
          (name === 'href' || name === 'src' || name === 'xlink:href' || name === 'formaction') &&
          isJavaScriptUrl(attr.value)
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

/**
 * Browsers strip leading whitespace and C0 control characters from a URL, and
 * ignore tabs and newlines anywhere inside the scheme. Normalize all of those
 * before testing the scheme so values such as `jav&#9;ascript:` or
 * `&#1;javascript:` cannot bypass the sanitizer.
 * @param {string} value URL attribute value.
 * @returns {boolean} Whether the value is a javascript: URL.
 */
function isJavaScriptUrl(value) {
  // eslint-disable-next-line no-control-regex
  return /^javascript:/i.test(String(value).replace(/[\x00-\x20]/g, ''));
}
