// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { sanitizeArticleHtml } from './articleHtml.js';

describe('articleHtml helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sanitizeArticleHtml', () => {
    it('returns empty string for falsy input', () => {
      expect(sanitizeArticleHtml('')).toBe('');
      expect(sanitizeArticleHtml(null)).toBe('');
    });

    it('removes executable elements and javascript: URLs', () => {
      const html =
        '<p onclick="alert(1)">safe</p><script>alert(1)</script>' +
        '<a href="javascript:evil()">x</a><img src="javascript:evil()">';
      const out = sanitizeArticleHtml(html);
      expect(out).toContain('safe');
      expect(out).not.toContain('script');
      expect(out).not.toContain('onclick');
      expect(out).not.toContain('javascript:');
    });

    it('returns empty string when DOMParser throws', () => {
      const OriginalDOMParser = globalThis.DOMParser;
      vi.stubGlobal(
        'DOMParser',
        class BrokenParser {
          parseFromString() {
            throw new Error('parse failed');
          }
        },
      );

      expect(sanitizeArticleHtml('<p>hello</p>')).toBe('');

      vi.stubGlobal('DOMParser', OriginalDOMParser);
    });
  });
});
