import { describe, it, expect } from 'vitest';
import { decodeEntities, stripTagsKeepOffsets } from './html.js';

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

  it('leaves invalid numeric entities unchanged when they cannot be decoded', () => {
    const result = stripTagsKeepOffsets('&#x110000; valid');
    expect(result.text).toBe('&#x110000; valid');
  });

  it('stops at unclosed script tags without a closing tag', () => {
    const result = stripTagsKeepOffsets('<p>before</p><script>alert(1)');
    expect(result.text).toBe('before');
    expect(result.text).not.toContain('alert');
  });

  it('stops at unclosed style tags without a closing tag', () => {
    const result = stripTagsKeepOffsets('<style>body{color:red}<p>after</p>');
    expect(result.text).toBe('');
  });

  it('strips zero-width character runs of length >= 4 and preserves mapping', () => {
    const html = 'a\u200b\u200c\u200d\ufeffb';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('ab');
    expect(result.mapping).toEqual([0, 5, 6]);
  });

  it('preserves isolated zero-width characters (run length < 4)', () => {
    const html = 'a\u200db\u200b\u200bc';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a\u200db\u200b\u200bc');
    expect(result.mapping).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('strips runs of decoded zero-width character entities of length >= 4', () => {
    const html = 'a&#x200b;&#x200c;&#x200d;&#xfeff;b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('ab');
    expect(result.mapping).toEqual([0, 33, 34]);
  });

  it('preserves isolated decoded zero-width character entities', () => {
    const html = 'a&#x200c;b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a\u200cb');
    expect(result.mapping).toEqual([0, 1, 9, 10]);
  });

  it('preserves bidirectional embedding/override control characters', () => {
    const html = 'a\u202a\u202b\u202c\u202d\u202eb';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a\u202a\u202b\u202c\u202d\u202eb');
    expect(result.mapping).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('collapses spaces flanking a stripped run of zero-width characters', () => {
    const html = 'word1 &#x200b;&#x200c;&#x200d;&#xfeff; word2';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('word1 word2');
    expect(result.mapping).toEqual([0, 1, 2, 3, 4, 5, 39, 40, 41, 42, 43, 44]);
  });

  it('collapses NBSP and other Unicode spaces to a single space', () => {
    const html = 'a  b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a b');
    expect(result.mapping).toEqual([0, 1, 3, 4]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('collapses line separator and paragraph separator to a single space', () => {
    const html = 'a  b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a b');
    expect(result.mapping).toEqual([0, 1, 3, 4]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('strips soft hyphen characters', () => {
    const html = 'a­b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('ab');
    expect(result.mapping).toEqual([0, 2, 3]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('strips word joiner characters', () => {
    const html = 'a⁠b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('ab');
    expect(result.mapping).toEqual([0, 2, 3]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('strips C0 and non-whitespace C1 control characters', () => {
    const c0Result = stripTagsKeepOffsets('ab');
    expect(c0Result.text).toBe('ab');
    expect(c0Result.mapping).toEqual([0, 2, 3]);
    expect(c0Result.mapping.length).toBe(c0Result.text.length + 1);

    const c1Result = stripTagsKeepOffsets('ab');
    expect(c1Result.text).toBe('ab');
    expect(c1Result.mapping).toEqual([0, 2, 3]);
    expect(c1Result.mapping.length).toBe(c1Result.text.length + 1);
  });

  it('normalizes literal NEXT LINE as whitespace with an exact mapping', () => {
    const html = 'a\u0085\u0085b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a b');
    expect(result.mapping).toEqual([0, 1, 3, 4]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('preserves an England subdivision-flag tag sequence and exact offsets', () => {
    const englandFlag = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
    const html = `a${englandFlag}b`;
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe(html);
    expect(result.mapping).toEqual(Array.from({ length: html.length + 1 }, (_, index) => index));
  });

  it('strips a standalone Tags-block character not preceded by the flag base char', () => {
    const html = 'a\u{e0041}\u{e0042}b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('ab');
    // 'a' at offset 0 (1 unit); \u{e0041} at offset 1 (2 units); \u{e0042} at offset 3 (2 units); 'b' at offset 5.
    expect(result.mapping).toEqual([0, 5, 6]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('preserves a bare waving-black-flag char with no following tag chars', () => {
    const html = 'a\u{1f3f4}b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe(html);
    expect(result.mapping).toEqual(Array.from({ length: html.length + 1 }, (_, index) => index));
  });

  it('strips a stray Tags-block char that follows a completed flag sequence', () => {
    const html = '\u{1f3f4}\u{e0067}\u{e007f}\u{e0041}';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('\u{1f3f4}\u{e0067}\u{e007f}');
    // Flag (offsets 0-5, 3 codepoints x 2 units = 6 units) is kept verbatim;
    // trailing \u{e0041} (offset 6, 2 units, original html length 8) is stripped.
    expect(result.mapping).toEqual([0, 1, 2, 3, 4, 5, 8]);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('applies legacy C1 remapping to numeric HTML references with exact offsets', () => {
    const html = 'a&#x80;b&#133;c';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a€b…c');
    expect(result.mapping).toEqual([0, 1, 7, 8, 14, 15]);
  });
});

describe('decodeEntities', () => {
  it('decodes named entities', () => {
    expect(decodeEntities('Claude&nbsp;Tag &amp; more &lt;x&gt;')).toBe('Claude Tag & more <x>');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeEntities('a&#160;b&#xa0;c')).toBe('a b c');
  });

  it('applies the complete HTML legacy C1 replacement table', () => {
    const references = [
      0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92,
      0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
    ].map((code) => `&#x${code.toString(16)};`);
    expect(decodeEntities(references.join(''))).toBe('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
  });

  it('leaves unknown or malformed entities untouched', () => {
    expect(decodeEntities('a&bogus;b & c &#x110000;')).toBe('a&bogus;b & c &#x110000;');
  });

  it('returns strings without ampersands unchanged', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});
