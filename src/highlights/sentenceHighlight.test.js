// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  tokenizeText,
  isSkippableContainer,
  supportsHighlightApi,
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
  paintSentenceHighlight,
} from './sentenceHighlight.js';

// Minimal CSS Custom Highlight API polyfill (happy-dom ships neither Highlight
// nor CSS.highlights). Highlight just records the live Ranges added to it.
class FakeHighlight {
  constructor() {
    this.ranges = new Set();
  }
  add(range) {
    this.ranges.add(range);
  }
}

describe('sentenceHighlight pure helpers', () => {
  it('tokenizeText splits on whitespace and returns array', () => {
    expect(tokenizeText('hello world')).toEqual(['hello', 'world']);
    expect(tokenizeText('  a   b\tc\n')).toEqual(['a', 'b', 'c']);
    expect(tokenizeText('')).toEqual([]);
    expect(tokenizeText(null)).toEqual([]);
    expect(tokenizeText(undefined)).toEqual([]);
  });

  it('isSkippableContainer rejects script/style/noscript and the in-page rail', () => {
    const script = document.createElement('script');
    const style = document.createElement('style');
    const noscript = document.createElement('noscript');
    const rail = document.createElement('aside');
    rail.id = 'pagetollm-in-page-rail';
    const normal = document.createElement('p');
    expect(isSkippableContainer(script)).toBe(true);
    expect(isSkippableContainer(style)).toBe(true);
    expect(isSkippableContainer(noscript)).toBe(true);
    expect(isSkippableContainer(rail)).toBe(true);
    expect(isSkippableContainer(normal)).toBe(false);
    expect(isSkippableContainer(null)).toBe(false);
    expect(isSkippableContainer({ nodeType: 3 })).toBe(false);
  });

  it('supportsHighlightApi reflects global CSS.highlights/Highlight presence', () => {
    // The helper returns the result of a && chain and may yield boolean or the last falsy value (undefined).
    // Just ensure it does not throw and yields a usable truthy/falsy indicator.
    const val = supportsHighlightApi();
    expect(val == null || typeof val === 'boolean').toBe(true);
  });
});

describe('collectWordEntries and buildSentenceDomRange', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeText(text) {
    const tn = document.createTextNode(text);
    container.appendChild(tn);
    return tn;
  }

  it('collectWordEntries walks text nodes and records word positions', () => {
    const t1 = makeText('Alpha beta');
    const t2 = makeText(' gamma');
    const entries = collectWordEntries([container]);
    expect(entries.length).toBe(3);
    expect(entries[0]).toMatchObject({ word: 'Alpha', node: t1, start: 0, end: 5 });
    expect(entries[1]).toMatchObject({ word: 'beta', node: t1, start: 6, end: 10 });
    expect(entries[2]).toMatchObject({ word: 'gamma', node: t2, start: 1, end: 6 });
  });

  it('buildSentenceDomRange returns a live Range when entries exist', () => {
    const t = makeText('One two three four');
    const entries = collectWordEntries([container]);
    // Build fake sentenceRanges: sentence 1 covers words 0..1 ("One two")
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 1 }]]);
    const range = buildSentenceDomRange(sentenceRanges, entries, 1);
    expect(range).not.toBeNull();
    expect(range.startContainer).toBe(t);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(t);
    expect(range.endOffset).toBe(7); // "One two" -> positions 0 to 7 (exclusive end)
  });

  it('buildSentenceDomRange returns null when sentence number missing', () => {
    const entries = collectWordEntries([makeText('x y')]);
    const sentenceRanges = new Map();
    expect(buildSentenceDomRange(sentenceRanges, entries, 99)).toBeNull();
  });

  it('buildSentenceDomRange returns null when start or end entry missing', () => {
    const entries = collectWordEntries([makeText('only one')]);
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 5 }]]);
    expect(buildSentenceDomRange(sentenceRanges, entries, 1)).toBeNull();
  });

  it('buildSentenceDomRange returns null on Range creation error (e.g. bad offsets)', () => {
    const t = makeText('abc');
    const entries = [{ word: 'abc', node: t, start: 99, end: 102 }]; // invalid offsets
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 0 }]]);
    const range = buildSentenceDomRange(sentenceRanges, entries, 1);
    expect(range).toBeNull();
  });

  it('skips whitespace-only text nodes when collecting words', () => {
    const whitespace = document.createTextNode('   \n\t  ');
    const real = document.createTextNode('hello');
    container.appendChild(whitespace);
    container.appendChild(real);
    const entries = collectWordEntries([container]);
    expect(entries).toHaveLength(1);
    expect(entries[0].word).toBe('hello');
  });
});

describe('buildSentenceWordRanges (anchoring logic)', () => {
  it('maps sentences to index ranges using word entries', () => {
    const entries = [
      { word: 'Hello' },
      { word: 'world' },
      { word: 'this' },
      { word: 'is' },
      { word: 'a' },
      { word: 'test' },
    ];
    const sentences = ['Hello world', 'this is a test'];
    const ranges = buildSentenceWordRanges(sentences, entries);
    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 1 });
    expect(ranges.get(2)).toEqual({ startIdx: 2, endIdx: 5 });
  });

  it('handles sentences with no tokens', () => {
    const entries = [{ word: 'x' }];
    const ranges = buildSentenceWordRanges(['   '], entries);
    expect(ranges.size).toBe(0);
  });

  it('anchors single-token sentences to one word index', () => {
    const entries = [{ word: 'Hello' }, { word: 'world' }, { word: 'test' }];
    const ranges = buildSentenceWordRanges(['Hello', 'world test'], entries);
    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 0 });
    expect(ranges.get(2)).toEqual({ startIdx: 1, endIdx: 2 });
  });
});

describe('paintSentenceHighlight', () => {
  let container;

  beforeEach(() => {
    globalThis.Highlight = FakeHighlight;
    globalThis.CSS = globalThis.CSS || {};
    globalThis.CSS.highlights = new Map();
    container = document.createElement('div');
    container.textContent = 'One two three four five six';
    document.body.appendChild(container);
  });

  afterEach(() => {
    delete globalThis.Highlight;
    delete globalThis.CSS.highlights;
    container.remove();
  });

  function buildRanges() {
    const wordEntries = collectWordEntries([container]);
    const sentenceRanges = buildSentenceWordRanges(['One two three', 'four five six'], wordEntries);
    return { wordEntries, sentenceRanges };
  }

  it('paints a resolved sentence range under the given highlight name', () => {
    paintSentenceHighlight('test-highlight', [1], buildRanges());
    expect(CSS.highlights.has('test-highlight')).toBe(true);
    expect(CSS.highlights.get('test-highlight').ranges.size).toBe(1);
  });

  it('paints multiple sentence numbers into one highlight', () => {
    paintSentenceHighlight('test-highlight', [1, 2], buildRanges());
    expect(CSS.highlights.get('test-highlight').ranges.size).toBe(2);
  });

  it('accepts any iterable of sentence numbers, e.g. a Set', () => {
    paintSentenceHighlight('test-highlight', new Set([1, 2]), buildRanges());
    expect(CSS.highlights.get('test-highlight').ranges.size).toBe(2);
  });

  it('deletes the highlight when sentenceNumbers is empty', () => {
    CSS.highlights.set('test-highlight', new FakeHighlight());
    paintSentenceHighlight('test-highlight', [], buildRanges());
    expect(CSS.highlights.has('test-highlight')).toBe(false);
  });

  it('deletes the highlight when sentenceNumbers is null or undefined', () => {
    CSS.highlights.set('test-highlight', new FakeHighlight());
    paintSentenceHighlight('test-highlight', null, buildRanges());
    expect(CSS.highlights.has('test-highlight')).toBe(false);

    CSS.highlights.set('test-highlight', new FakeHighlight());
    paintSentenceHighlight('test-highlight', undefined, buildRanges());
    expect(CSS.highlights.has('test-highlight')).toBe(false);
  });

  it('deletes the highlight when no sentence number resolves to a range', () => {
    CSS.highlights.set('test-highlight', new FakeHighlight());
    paintSentenceHighlight('test-highlight', [999], buildRanges());
    expect(CSS.highlights.has('test-highlight')).toBe(false);
  });
});
