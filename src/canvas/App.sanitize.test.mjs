// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { sanitizeArticleHtml, escapeHtml } from '../highlights/articleHtml.js';

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
    expect(out).not.toMatch(/javascript:/i);
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

describe('escapeHtml', () => {
  it('escapes HTML metacharacters', () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe('&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
  });

  it('coerces falsy values to empty string', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});
