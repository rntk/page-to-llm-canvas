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

    it('leaves URLs untouched without a source URL', () => {
      const out = sanitizeArticleHtml('<img src="/img/a.png"><a href="page.html">x</a>');

      expect(out).toContain('src="/img/a.png"');
      expect(out).toContain('href="page.html"');
    });

    it('resolves relative and protocol-relative URLs against the source URL', () => {
      const out = sanitizeArticleHtml(
        '<img src="/img/a.png"><img src="b.png"><img src="//cdn.example.com/c.png">' +
          '<a href="page.html">x</a><img src="https://other.example/d.png">',
        'https://news.example/section/story.html',
      );

      expect(out).toContain('src="https://news.example/img/a.png"');
      expect(out).toContain('src="https://news.example/section/b.png"');
      expect(out).toContain('src="https://cdn.example.com/c.png"');
      expect(out).toContain('href="https://news.example/section/page.html"');
      expect(out).toContain('src="https://other.example/d.png"');
    });

    it('resolves every srcset candidate and keeps its descriptor', () => {
      const out = sanitizeArticleHtml(
        '<img srcset="a.png 1x, /b.png 2x">',
        'https://news.example/section/story.html',
      );

      expect(out).toContain(
        'srcset="https://news.example/section/a.png 1x, https://news.example/b.png 2x"',
      );
    });

    it('keeps commas that belong to a srcset candidate URL', () => {
      const out = sanitizeArticleHtml(
        '<img srcset="data:image/png;base64,AAAA 1x, /b,c.png 2x">' +
          '<img srcset="/one.png, /two.png">',
        'https://news.example/section/story.html',
      );

      expect(out).toContain(
        'srcset="data:image/png;base64,AAAA 1x, https://news.example/b,c.png 2x"',
      );
      expect(out).toContain('srcset="https://news.example/one.png, https://news.example/two.png"');
    });

    it('promotes lazy-loading sources over an absent or placeholder src', () => {
      const out = sanitizeArticleHtml(
        '<img data-src="/a.png"><img src="data:image/gif;base64,R0lGOD" data-src="/b.png">' +
          '<img src="/real.png" data-src="/ignored.png"><img data-srcset="/c.png 2x">',
        'https://news.example/story.html',
      );

      expect(out).toContain('src="https://news.example/a.png"');
      expect(out).toContain('src="https://news.example/b.png"');
      expect(out).toContain('src="https://news.example/real.png"');
      expect(out).not.toContain('ignored.png');
      expect(out).toContain('srcset="https://news.example/c.png 2x"');
    });

    it('still drops a javascript: URL promoted out of a lazy attribute', () => {
      const out = sanitizeArticleHtml(
        '<img data-src="javascript:evil()">',
        'https://news.example/story.html',
      );

      expect(out).not.toContain('javascript:');
    });

    it('ignores an unusable source URL', () => {
      const out = sanitizeArticleHtml('<img src="/img/a.png">', 'not a url');

      expect(out).toContain('src="/img/a.png"');
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
