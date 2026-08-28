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

    it('drops javascript: URLs hidden behind ignored URL characters', () => {
      const out = sanitizeArticleHtml(
        '<a href="jav&#9;ascript:evil()">tabbed</a>' +
          '<img src="&#1;javascript:evil()">' +
          '<a xlink:href="java&#10;script:evil()">newline</a>',
      );

      expect(out).not.toContain('href');
      expect(out).not.toContain('src');
    });

    it('unwraps forms and removes javascript: form actions', () => {
      const out = sanitizeArticleHtml(
        '<form action="https://attacker.example"><p>article body</p></form>' +
          '<button formaction="javascript:evil()">submit</button>',
      );

      expect(out).not.toContain('<form');
      expect(out).not.toContain('attacker.example');
      expect(out).not.toContain('formaction');
      expect(out).toContain('<p>article body</p>');
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
