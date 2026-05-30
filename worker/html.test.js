import { describe, it, expect } from 'vitest';
import { stripTagsKeepOffsets } from './html.js';

describe('stripTagsKeepOffsets', () => {
  it('returns empty text for empty string', () => {
    const result = stripTagsKeepOffsets('');
    expect(result.text).toBe('');
  });

  it('returns plain text unchanged', () => {
    const result = stripTagsKeepOffsets('hello world');
    expect(result.text).toBe('hello world');
  });

  it('strips simple HTML tags', () => {
    const result = stripTagsKeepOffsets('<p>hello</p>');
    expect(result.text).toBe('hello');
  });

  it('strips nested tags', () => {
    const result = stripTagsKeepOffsets('<div><p>hello</p><p>world</p></div>');
    expect(result.text).toBe('hello world');
  });

  it('strips self-closing tags', () => {
    const result = stripTagsKeepOffsets('hello<br/>world');
    expect(result.text).toBe('hello world');
  });

  it('strips script tags and their content', () => {
    const result = stripTagsKeepOffsets("<p>before</p><script>alert('xss')</script><p>after</p>");
    expect(result.text).toBe('before after');
    expect(result.text).not.toContain('alert');
  });

  it('strips style tags and their content', () => {
    const result = stripTagsKeepOffsets('<style>body{color:red}</style><p>text</p>');
    expect(result.text).toBe('text');
    expect(result.text).not.toContain('color');
  });

  it('decodes named HTML entities', () => {
    const result = stripTagsKeepOffsets('&amp; &lt; &gt;');
    expect(result.text).toBe('& < >');
  });

  it('decodes numeric HTML entities', () => {
    const result = stripTagsKeepOffsets('&#65; &#66;');
    expect(result.text).toBe('A B');
  });

  it('decodes hex HTML entities', () => {
    const result = stripTagsKeepOffsets('&#x41; &#x42;');
    expect(result.text).toBe('A B');
  });

  it('decodes &nbsp; entity', () => {
    const result = stripTagsKeepOffsets('hello&nbsp;world');
    expect(result.text).toContain('hello');
    expect(result.text).toContain('world');
  });

  it('collapses whitespace runs', () => {
    const result = stripTagsKeepOffsets('hello   \n\n   world');
    expect(result.text).toBe('hello world');
  });

  it('trims leading whitespace', () => {
    const result = stripTagsKeepOffsets('   hello');
    expect(result.text).toBe('hello');
  });

  it('trims trailing whitespace', () => {
    const result = stripTagsKeepOffsets('hello   ');
    expect(result.text).toBe('hello');
  });

  it('mapping has same length as output text plus sentinel', () => {
    const result = stripTagsKeepOffsets('<p>ab</p>');
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('mapping offsets are valid indices into the original HTML', () => {
    const html = 'ab<p>cd</p>ef';
    const result = stripTagsKeepOffsets(html);
    for (let i = 0; i < result.text.length; i++) {
      expect(result.mapping[i]).toBeGreaterThanOrEqual(0);
      expect(result.mapping[i]).toBeLessThan(html.length);
    }
  });

  it('mapping preserves text character positions for plain text regions', () => {
    const html = 'hello world';
    const result = stripTagsKeepOffsets(html);
    for (let i = 0; i < result.text.length; i++) {
      expect(html[result.mapping[i]]).toBe(result.text[i]);
    }
  });

  it('handles unclosed tags gracefully', () => {
    const result = stripTagsKeepOffsets('<p>hello');
    expect(result.text).toBe('hello');
  });

  it('handles tags with attributes', () => {
    const result = stripTagsKeepOffsets('<a href="http://example.com">link</a>');
    expect(result.text).toBe('link');
  });
});
