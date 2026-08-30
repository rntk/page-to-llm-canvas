import { describe, it, expect } from 'vitest';
import { decodeEntities, normalizePlainTextKeepOffsets, stripTagsKeepOffsets } from './html.js';

describe('normalizePlainTextKeepOffsets', () => {
  it('preserves literal markup-looking characters from captured DOM text', () => {
    const input = 'a <b> &amp; b';
    const result = normalizePlainTextKeepOffsets(input);
    expect(result.text).toBe('a <b> &amp; b');
    expect(result.mapping).toEqual(
      Array.from({ length: result.text.length }, (_, i) => i).concat(input.length),
    );
  });

  it('applies the same whitespace, control, and suspicious zero-width policy', () => {
    const input = '  before\n\n\u0001\u200b\u200b\u200b\u200b after  ';
    const result = normalizePlainTextKeepOffsets(input);
    expect(result.text).toBe('before after');
    expect(result.mapping.at(-1)).toBe(input.length);
    expect(result.mapping.length).toBe(result.text.length + 1);
  });

  it('does not decode entity-looking text', () => {
    expect(normalizePlainTextKeepOffsets('&lt; &amp; &#65;').text).toBe('&lt; &amp; &#65;');
  });
});

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

  it('drops the contents of a closed details element but keeps its summary', () => {
    const result = stripTagsKeepOffsets(
      '<p>before</p><details><summary>Question</summary><p>collapsed answer</p></details><p>after</p>',
    );
    expect(result.text).toBe('before Question after');
  });

  it('keeps the contents of an open details element', () => {
    const result = stripTagsKeepOffsets(
      '<details open><summary>Question</summary><p>answer</p></details>',
    );
    expect(result.text).toBe('Question answer');
  });

  it('drops a closed details element that has no summary', () => {
    const result = stripTagsKeepOffsets(
      '<p>before</p><details><p>hidden</p></details><p>after</p>',
    );
    expect(result.text).toBe('before after');
  });

  it('keeps only the outer summary when a closed details nests another', () => {
    const result = stripTagsKeepOffsets(
      '<details><summary>Outer</summary><details><summary>Inner</summary><p>deep</p></details></details>after',
    );
    expect(result.text).toBe('Outer after');
  });

  it('drops a summary the closed details does not own as a direct child', () => {
    // Browsers only expose a direct <summary> child; a wrapped one stays hidden.
    const result = stripTagsKeepOffsets(
      '<p>before</p><details><div><summary>wrapped</summary></div><p>answer</p></details><p>after</p>',
    );
    expect(result.text).toBe('before after');
  });

  it('keeps the direct summary even when a wrapped one comes first', () => {
    const result = stripTagsKeepOffsets(
      '<details><div><summary>wrapped</summary></div><summary>Real</summary><p>answer</p></details>',
    );
    expect(result.text).toBe('Real');
  });

  it('keeps the summary when script text before it contains a bare <', () => {
    const result = stripTagsKeepOffsets(
      '<details><script>if(a<b){x>y}</script><summary>Question</summary><p>answer</p></details>after',
    );
    expect(result.text).toBe('Question after');
  });

  it('keeps the summary when RCDATA text before it looks like markup', () => {
    // The browser reads `<b>` inside a textarea as text, so <summary> is still
    // the details' direct child.
    const result = stripTagsKeepOffsets(
      '<details><textarea><b>x</textarea><summary>Real</summary><p>a</p></details>after',
    );
    expect(result.text).toBe('Real after');
  });

  it('ends raw-text and RCDATA elements at their first end tag', () => {
    // A same-name start tag inside them is text, so it must not nest: counting
    // it would swallow the summary, and for <script> the whole document.
    expect(
      stripTagsKeepOffsets(
        '<details><textarea><textarea>x</textarea><summary>Real</summary><p>a</p></details>after',
      ).text,
    ).toBe('Real after');
    expect(
      stripTagsKeepOffsets(
        '<details><script>var s = "<script>";</script><summary>Real</summary></details>after',
      ).text,
    ).toBe('Real after');
    expect(stripTagsKeepOffsets('<p>a</p><script>var s = "<script>";</script><p>b</p>').text).toBe(
      'a b',
    );
  });

  it('drops elements hidden by the hidden attribute whatever its value', () => {
    expect(stripTagsKeepOffsets('<p>a</p><div hidden>gone</div><p>b</p>').text).toBe('a b');
    expect(stripTagsKeepOffsets('<p>a</p><div hidden="false">gone</div><p>b</p>').text).toBe('a b');
    expect(stripTagsKeepOffsets('<p>a</p><div hidden="until-found">gone</div><p>b</p>').text).toBe(
      'a b',
    );
  });

  it('drops elements hidden by an inline style declaration', () => {
    expect(stripTagsKeepOffsets('<p>a</p><div style="display:none">gone</div><p>b</p>').text).toBe(
      'a b',
    );
    expect(
      stripTagsKeepOffsets(
        '<p>a</p><div style="color:red; content-visibility: hidden;">gone</div>b',
      ).text,
    ).toBe('a b');
  });

  it('drops elements whose hiding declaration carries !important', () => {
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="display:none !important">gone</div><p>b</p>').text,
    ).toBe('a b');
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="display:none!important;color:red">gone</div>b')
        .text,
    ).toBe('a b');
  });

  it('keeps text under visibility:hidden, which a descendant can override', () => {
    // visibility still generates line boxes, so the text measures to a real
    // rect; a `visibility:visible` descendant is painted normally.
    const result = stripTagsKeepOffsets(
      '<div style="visibility:hidden"><span style="visibility:visible">shown</span></div>',
    );
    expect(result.text).toBe('shown');
  });

  it('resolves repeated display declarations in cascade order', () => {
    // A later declaration wins, so the element renders.
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="display:none;display:block">shown</div>').text,
    ).toBe('a shown');
    expect(
      stripTagsKeepOffsets(
        '<p>a</p><div style="display:none!important;display:block!important">shown</div>',
      ).text,
    ).toBe('a shown');
    // ...but a normal declaration never overrides an important one.
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="display:none!important;display:block">gone</div>b')
        .text,
    ).toBe('a b');
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="display:block;display:none">gone</div><p>b</p>')
        .text,
    ).toBe('a b');
  });

  it('does not split declarations at semicolons inside strings or parentheses', () => {
    // A custom property whose value is a string containing `;display:none;`.
    expect(stripTagsKeepOffsets(`<p>a</p><div style="--x:';display:none;'">shown</div>`).text).toBe(
      'a shown',
    );
    expect(
      stripTagsKeepOffsets('<p>a</p><div style="background:url(a;b);color:red">shown</div>').text,
    ).toBe('a shown');
  });

  it('keeps elements whose inline style only resembles a hiding declaration', () => {
    const result = stripTagsKeepOffsets(
      '<div style="background:url(a.png#display:none)">kept</div>',
    );
    expect(result.text).toBe('kept');
  });

  it('drops template and noscript contents but keeps a closed dialog out of the text', () => {
    expect(stripTagsKeepOffsets('<template><a>chrome</a></template><p>text</p>').text).toBe('text');
    expect(stripTagsKeepOffsets('<noscript><p>enable js</p></noscript><p>text</p>').text).toBe(
      'text',
    );
    expect(stripTagsKeepOffsets('<dialog><p>modal</p></dialog><p>text</p>').text).toBe('text');
    expect(stripTagsKeepOffsets('<dialog open><p>modal</p></dialog>').text).toBe('modal');
  });

  it('does not end a hidden element early on a > inside a quoted attribute', () => {
    const result = stripTagsKeepOffsets('<div title="a>b" hidden>gone</div><p>after</p>');
    expect(result.text).toBe('after');
  });

  it('ignores a hidden attribute inside script content', () => {
    const result = stripTagsKeepOffsets('<script>var s = "<div hidden>";</script><p>after</p>');
    expect(result.text).toBe('after');
  });

  it('keeps void elements carrying a hidden attribute from swallowing later text', () => {
    const result = stripTagsKeepOffsets('<p>before</p><img hidden src="a.png"><p>after</p>');
    expect(result.text).toBe('before after');
  });

  it('maps text after a dropped hidden subtree back to its original offsets', () => {
    const html = 'a<div hidden>gone</div>b';
    const result = stripTagsKeepOffsets(html);
    expect(result.text).toBe('a b');
    expect(html[result.mapping[0]]).toBe('a');
    expect(html[result.mapping[2]]).toBe('b');
    expect(result.mapping.length).toBe(result.text.length + 1);
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
    expect(decodeEntities('&amp')).toBe('&amp');
    expect(decodeEntities('&#65')).toBe('&#65');
  });

  it('does not decode entity-like text that lacks an ampersand while scanning a later entity', () => {
    expect(decodeEntities('x#65; &amp;')).toBe('x#65; &');
  });

  // NOTE: '&#000000065;' is a well-formed reference that a browser decodes to
  // 'A'. It survives here only because decodeEntityAt gives up once the ';' is
  // more than 10 chars away (html.js), a scan bound rather than a spec rule.
  // This asserts the bound, so a change to it is a deliberate decision and not
  // a silent regression -- it is not a claim that leading zeros are invalid.
  it('leaves a numeric reference longer than the entity scan bound intact', () => {
    expect(decodeEntities('&#000000065;')).toBe('&#000000065;');
    expect(decodeEntities('&#65 padding &amp;')).toBe('&#65 padding &');
  });

  it('decodes a numeric reference at the edge of the scan bound', () => {
    // Body is exactly at the limit, so this one still decodes.
    expect(decodeEntities('&#00000065;')).toBe('A');
  });

  it('returns strings without ampersands unchanged', () => {
    expect(decodeEntities('plain text')).toBe('plain text');
  });
});
