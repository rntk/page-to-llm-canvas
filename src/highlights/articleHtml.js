/**
 * Remove executable markup from stored article HTML before rendering it in the
 * extension page. Images and inline styles remain, so opening a record may
 * request images from the source page.
 *
 * Resolve relative URLs against the source page instead of the extension origin.
 * @param {string} html Stored article HTML.
 * @param {string} [baseUrl] The record's source URL, used to resolve relative
 *   `src`/`href`/`srcset` values. Omitted: URLs are left exactly as stored.
 */
export function sanitizeArticleHtml(html, baseUrl) {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(String(html), 'text/html');
    doc
      .querySelectorAll('script, style, noscript, iframe, object, embed, link, meta, base')
      .forEach((el) => el.remove());
    // Validate attributes after promoting lazy image sources.
    resolveArticleUrls(doc, baseUrl);
    // Preserve form contents; the extension CSP blocks submission.
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

// Promote only known lazy source attributes; other data attributes may be IDs.
const URL_ATTRIBUTES = ['src', 'href', 'poster'];
const SRCSET_ATTRIBUTES = ['srcset', 'imagesrcset'];
const LAZY_SRC_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original'];
const LAZY_SRCSET_ATTRIBUTES = ['data-srcset', 'data-lazy-srcset'];

/**
 * Resolve every URL in the parsed article against the record's source page.
 *
 * Relative and protocol-relative URLs otherwise resolve against the extension
 * origin. Leave attributes untouched without a usable base URL.
 * @param {Document} doc Parsed article document.
 * @param {string} [baseUrl] Record source URL.
 */
function resolveArticleUrls(doc, baseUrl) {
  if (!baseUrl || !absolutizeUrl('.', baseUrl)) return;
  doc.querySelectorAll('img, source').forEach((el) => promoteLazySources(el));
  doc.querySelectorAll('*').forEach((el) => {
    for (const name of URL_ATTRIBUTES) {
      const absolute = el.hasAttribute(name) && absolutizeUrl(el.getAttribute(name), baseUrl);
      if (absolute) el.setAttribute(name, absolute);
    }
    for (const name of SRCSET_ATTRIBUTES) {
      const absolute = el.hasAttribute(name) && absolutizeSrcset(el.getAttribute(name), baseUrl);
      if (absolute) el.setAttribute(name, absolute);
    }
  });
}

/**
 * Move a lazy-loading image's real source into `src`/`srcset`.
 *
 * Replace only an absent or `data:` placeholder `src`; preserve a real fallback.
 * Remove the lazy attributes after promotion.
 * @param {Element} el An `img` or `source` element.
 */
function promoteLazySources(el) {
  const src = el.getAttribute('src');
  if (!src || /^data:/i.test(src.trim())) {
    const lazySrc = LAZY_SRC_ATTRIBUTES.map((name) => el.getAttribute(name)).find(Boolean);
    if (lazySrc) el.setAttribute('src', lazySrc);
  }
  if (!el.getAttribute('srcset')) {
    const lazySrcset = LAZY_SRCSET_ATTRIBUTES.map((name) => el.getAttribute(name)).find(Boolean);
    if (lazySrcset) el.setAttribute('srcset', lazySrcset);
  }
  [...LAZY_SRC_ATTRIBUTES, ...LAZY_SRCSET_ATTRIBUTES].forEach((name) => el.removeAttribute(name));
}

/**
 * @param {string} value URL attribute value.
 * @param {string} baseUrl Base to resolve against.
 * @returns {?string} Absolute URL, or null when the value cannot be resolved.
 */
function absolutizeUrl(value, baseUrl) {
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve every candidate in a `srcset`, keeping each one's descriptor.
 * @param {string} value `srcset` attribute value.
 * @param {string} baseUrl Base to resolve against.
 * @returns {?string} Rewritten `srcset`, or null when nothing resolved.
 */
function absolutizeSrcset(value, baseUrl) {
  const candidates = parseSrcsetCandidates(value)
    .map(({ url, descriptor }) => {
      const absolute = absolutizeUrl(url, baseUrl);
      if (!absolute) return null;
      return descriptor ? `${absolute} ${descriptor}` : absolute;
    })
    .filter(Boolean);
  return candidates.length ? candidates.join(', ') : null;
}

/**
 * Split a `srcset` into its candidates, following the attribute's own grammar.
 *
 * URLs can contain commas, as in `data:image/png;base64,AAAA 1x`, so splitting
 * the raw attribute on commas would break valid candidates.
 * @param {string} value `srcset` attribute value.
 * @returns {Array<{url: string, descriptor: string}>}
 */
function parseSrcsetCandidates(value) {
  const text = String(value);
  const isWhitespace = (char) => /\s/.test(char);
  const candidates = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length && (isWhitespace(text[index]) || text[index] === ',')) index += 1;
    const urlStart = index;
    while (index < text.length && !isWhitespace(text[index])) index += 1;
    const rawUrl = text.slice(urlStart, index);
    if (!rawUrl) break;

    // Trailing commas end the candidate right there — the descriptor, if any,
    // belongs to whatever follows.
    const url = rawUrl.replace(/,+$/, '');
    let descriptor = '';
    if (url === rawUrl) {
      while (index < text.length && isWhitespace(text[index])) index += 1;
      const descriptorStart = index;
      while (index < text.length && text[index] !== ',') index += 1;
      descriptor = text.slice(descriptorStart, index).trim();
    }
    if (url) candidates.push({ url, descriptor });
  }

  return candidates;
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
