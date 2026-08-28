// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { sanitizeArticleHtml } from '../highlights/articleHtml.js';

describe('sanitizeArticleHtml', () => {
  it('strips <script> elements but keeps surrounding text', () => {
    const out = sanitizeArticleHtml('<p>Hello<script>alert(1)</script>world</p>');
    expect(out).not.toMatch(/<script/i);
    expect(out).toContain('Hello');
    expect(out).toContain('world');
  });

  it('removes inline event-handler attributes', () => {
    const out = sanitizeArticleHtml('<img src="x.png" onerror="alert(1)" onclick="x()">');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toMatch(/src="x\.png"/i);
  });

  it('drops javascript: URLs on href/src', () => {
    const out = sanitizeArticleHtml('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toMatch(/href/i);
  });

  // The scheme check must survive the characters browsers ignore while parsing
  // a URL. Assert on `href` rather than the literal `javascript:` string: a
  // surviving attribute serializes with the tab/control byte still embedded,
  // so a `/javascript:/` assertion would pass even when the attribute leaks.
  it('drops javascript: URLs obfuscated with tabs and control characters', () => {
    const out = sanitizeArticleHtml(
      '<a href="jav&#9;ascript:alert(1)">tab</a>' +
        '<a href="&#1;javascript:alert(1)">control</a>' +
        '<a href="java&#10;script:alert(1)">newline</a>',
    );
    expect(out).not.toMatch(/href/i);
  });

  it('unwraps forms and removes form submission attributes', () => {
    const out = sanitizeArticleHtml(
      '<form action="https://attacker.example"><p>article body</p></form>' +
        '<button formaction="javascript:alert(1)">submit</button>',
    );
    expect(out).not.toMatch(/<form|attacker\.example|formaction/i);
    expect(out).toContain('<p>article body</p>');
  });

  it('removes embedding/loading tags (iframe, object, embed, link, style, meta)', () => {
    const out = sanitizeArticleHtml(
      '<style>p{color:red}</style><iframe src="evil"></iframe><object></object><embed><link rel="x"><meta><p>keep</p>',
    );
    expect(out).not.toMatch(/<iframe|<object|<embed|<style|<link|<meta/i);
    expect(out).toContain('keep');
  });

  it('preserves structural markup and inline style attributes for readability', () => {
    const out = sanitizeArticleHtml(
      '<h2>Title</h2><p style="font-weight:bold">Body</p><ul><li>item</li></ul>',
    );
    expect(out).toMatch(/<h2>Title<\/h2>/);
    expect(out).toMatch(/style="font-weight:bold"/);
    expect(out).toMatch(/<li>item<\/li>/);
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeArticleHtml('')).toBe('');
    expect(sanitizeArticleHtml(null)).toBe('');
    expect(sanitizeArticleHtml(undefined)).toBe('');
  });
});
