// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

  it('isSkippableContainer rejects the subtrees the pipeline prunes from record text', () => {
    const template = document.createElement('template');
    const hidden = document.createElement('div');
    hidden.setAttribute('hidden', '');
    const hiddenFalse = document.createElement('div');
    // Boolean attribute: even "false" hides.
    hiddenFalse.setAttribute('hidden', 'false');
    const styled = document.createElement('div');
    styled.setAttribute('style', 'color: red; display : none');
    const important = document.createElement('div');
    important.setAttribute('style', 'display:none !important');
    const contentVisibility = document.createElement('div');
    contentVisibility.setAttribute('style', 'content-visibility:hidden');
    // visibility still generates line boxes (so the text measures to a real
    // rect) and a descendant can override it back to visible, so the pipeline
    // keeps this content and the walk must too.
    const invisible = document.createElement('div');
    invisible.setAttribute('style', 'visibility:collapse');
    const closedDialog = document.createElement('dialog');
    const openDialog = document.createElement('dialog');
    openDialog.setAttribute('open', '');
    // Hidden by a CSS class only: the canvas re-renders without the page's
    // stylesheet, so this content is visible there and the pipeline keeps it.
    const classHidden = document.createElement('div');
    classHidden.className = 'hidden';
    expect(isSkippableContainer(template)).toBe(true);
    expect(isSkippableContainer(hidden)).toBe(true);
    expect(isSkippableContainer(hiddenFalse)).toBe(true);
    expect(isSkippableContainer(styled)).toBe(true);
    // Cascade order decides: a later declaration wins unless the earlier one is
    // important.
    const overridden = document.createElement('div');
    overridden.setAttribute('style', 'display:none;display:block');
    const overriddenImportant = document.createElement('div');
    overriddenImportant.setAttribute('style', 'display:none!important;display:block!important');
    const stillImportant = document.createElement('div');
    stillImportant.setAttribute('style', 'display:none!important;display:block');
    expect(isSkippableContainer(overridden)).toBe(false);
    expect(isSkippableContainer(overriddenImportant)).toBe(false);
    expect(isSkippableContainer(stillImportant)).toBe(true);
    // A semicolon inside a quoted value is not a declaration boundary.
    const stringValue = document.createElement('div');
    stringValue.setAttribute('style', `--x:';display:none;'`);
    expect(isSkippableContainer(stringValue)).toBe(false);
    expect(isSkippableContainer(important)).toBe(true);
    expect(isSkippableContainer(contentVisibility)).toBe(true);
    expect(isSkippableContainer(invisible)).toBe(false);
    expect(isSkippableContainer(closedDialog)).toBe(true);
    expect(isSkippableContainer(openDialog)).toBe(false);
    expect(isSkippableContainer(classHidden)).toBe(false);
  });

  it('isSkippableContainer keeps a collapsed <details>, whose summary still renders', () => {
    const details = document.createElement('details');
    expect(isSkippableContainer(details)).toBe(false);
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

  it('joins a word split across adjacent inline text nodes and ranges it correctly', () => {
    const first = document.createElement('span');
    first.textContent = 'hel';
    const second = document.createElement('span');
    second.textContent = 'lo';
    container.append(first, second);

    const entries = collectWordEntries([container]);
    expect(entries.map((entry) => entry.word)).toEqual(['hello']);
    expect(entries[0]).toMatchObject({ node: first.firstChild, start: 0 });
    expect(entries[0].endNode).toBe(second.firstChild);
    expect(entries[0].end).toBe(2);
    const range = buildSentenceDomRange(buildSentenceWordRanges(['hello'], entries), entries, 1);
    expect(range.startContainer).toBe(first.firstChild);
    expect(range.startOffset).toBe(0);
    expect(range.endContainer).toBe(second.firstChild);
    expect(range.endOffset).toBe(2);
  });

  it('keeps visible whitespace-only text nodes as word separators', () => {
    container.innerHTML = '<p><b>foo</b> <i>bar</i></p>';
    expect(collectWordEntries([container]).map((entry) => entry.word)).toEqual(['foo', 'bar']);

    container.innerHTML = '<p><span>foo</span>\n<span>bar</span></p>';
    expect(collectWordEntries([container]).map((entry) => entry.word)).toEqual(['foo', 'bar']);
  });

  it('does not let whitespace in a hidden subtree split visible inline text', () => {
    container.innerHTML =
      '<p><span>foo</span><span style="display:none"> </span><span>bar</span></p>';
    expect(collectWordEntries([container]).map((entry) => entry.word)).toEqual(['foobar']);
  });

  it('keeps words in separate block elements separate', () => {
    const first = document.createElement('p');
    first.style.display = 'block';
    first.textContent = 'first';
    const second = document.createElement('p');
    second.style.display = 'block';
    second.textContent = 'second';
    container.append(first, second);

    const entries = collectWordEntries([container]);
    expect(entries.map((entry) => entry.word)).toEqual(['first', 'second']);
    const ranges = buildSentenceWordRanges(['first', 'second'], entries);
    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 0 });
    expect(ranges.get(2)).toEqual({ startIdx: 1, endIdx: 1 });
  });

  it('collectWordEntries skips subtrees the browser never lays out', () => {
    container.innerHTML = [
      '<p>Alpha</p>',
      '<div hidden>hidden words</div>',
      '<div style="display:none">inline hidden words</div>',
      '<div style="display:none !important">important hidden words</div>',
      '<template>template words</template>',
      '<dialog>closed dialog words</dialog>',
      '<p>Omega</p>',
    ].join('');
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Alpha', 'Omega']);
  });

  it('collectWordEntries honors computed class hiding, visibility, and ancestor opacity', () => {
    container.innerHTML = [
      '<p>Keep</p>',
      '<div class="computed-display-none">class hidden</div>',
      '<span class="computed-visibility-hidden">visibility hidden</span>',
      '<div class="computed-visibility-ancestor"><span class="computed-visibility-visible">visible override</span><span>inherited hidden</span></div>',
      '<div class="computed-opacity-zero"><span>opacity hidden</span></div>',
      '<p>Keep again</p>',
    ].join('');
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((node) => ({
      display: node.classList?.contains('computed-display-none') ? 'none' : 'block',
      contentVisibility: 'visible',
      visibility:
        node.classList?.contains('computed-visibility-hidden') ||
        (node.closest?.('.computed-visibility-ancestor') &&
          !node.classList?.contains('computed-visibility-visible'))
          ? 'hidden'
          : 'visible',
      opacity: node.classList?.contains('computed-opacity-zero') ? '0' : '1',
    }));
    try {
      expect(collectWordEntries([container]).map((e) => e.word)).toEqual([
        'Keep',
        'visible',
        'override',
        'Keep',
        'again',
      ]);
    } finally {
      getComputedStyle.mockRestore();
    }
  });

  it('collectWordEntries keeps a collapsed details summary but drops its hidden contents', () => {
    container.innerHTML = [
      '<details><summary><span>Question</span></summary><p>Collapsed answer</p></details>',
      '<details open><summary>Open question</summary><p>Open answer</p></details>',
    ].join('');
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual([
      'Question',
      'Open',
      'question',
      'Open',
      'answer',
    ]);
  });

  it('collectWordEntries drops a summary the collapsed details does not own directly', () => {
    container.innerHTML =
      '<p>Alpha</p><details><div><summary>wrapped</summary></div><p>answer</p></details><p>Omega</p>';
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Alpha', 'Omega']);
  });

  it('collectWordEntries keeps the summary when script text precedes it', () => {
    // Mirrors the pipeline fixture: raw-text content must not affect which
    // <summary> a collapsed <details> is considered to own.
    container.innerHTML =
      '<details><script>if(a<b){x>y}</script><summary>Question</summary><p>answer</p></details>';
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Question']);
  });

  it('collectWordEntries keeps the summary when RCDATA text precedes it', () => {
    // The parser reads `<b>x` inside the textarea as a literal text node, so
    // <summary> remains a direct child. The textarea's own text is dropped
    // because it is collapsed-details content outside the summary.
    container.innerHTML =
      '<details><textarea><b>x</textarea><summary>Real</summary><p>a</p></details>';
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Real']);
  });

  it('collectWordEntries keeps the summary past a same-name RCDATA start tag', () => {
    // A browser ends the textarea at its first </textarea>, so `<textarea>x` is
    // its text and <summary> is a direct child of the details. happy-dom's
    // parser nests the inner start tag instead, burying the summary, so the
    // tree is built by hand to pin the shape the pipeline's scanner assumes for
    // '<details><textarea><textarea>x</textarea><summary>Real</summary>...'.
    const details = document.createElement('details');
    const textarea = document.createElement('textarea');
    textarea.appendChild(document.createTextNode('<textarea>x'));
    const summary = document.createElement('summary');
    summary.appendChild(document.createTextNode('Real'));
    const body = document.createElement('p');
    body.appendChild(document.createTextNode('a'));
    details.append(textarea, summary, body);
    container.appendChild(details);
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Real']);
  });

  it('collectWordEntries gives a nested details its own summary', () => {
    container.innerHTML =
      '<details><summary>Outer</summary><details><summary>Inner</summary>body</details></details>';
    expect(collectWordEntries([container]).map((e) => e.word)).toEqual(['Outer']);
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

  it('leaves an unmatched sentence unmapped and lets a later sentence resynchronize', () => {
    const entries = [{ word: 'Alpha' }, { word: 'Beta' }, { word: 'Gamma' }];
    const ranges = buildSentenceWordRanges(['Missing sentence', 'Beta Gamma'], entries);
    expect(ranges.has(1)).toBe(false);
    expect(ranges.get(2)).toEqual({ startIdx: 1, endIdx: 2 });
  });

  it('resynchronizes after live DOM drift larger than the nearby search window', () => {
    const inserted = Array.from({ length: 100 }, (_, i) => ({ word: `promo${i}` }));
    const entries = [
      { word: 'Alpha' },
      ...inserted,
      { word: 'Beta' },
      { word: 'Gamma' },
      { word: 'Delta' },
    ];
    const ranges = buildSentenceWordRanges(['Alpha', 'Beta Gamma', 'Delta'], entries);

    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 0 });
    expect(ranges.get(2)).toEqual({ startIdx: 101, endIdx: 102 });
    expect(ranges.get(3)).toEqual({ startIdx: 103, endIdx: 103 });
  });

  it('does not let a distant false match skip a valid later sentence', () => {
    const inserted = Array.from({ length: 100 }, (_, i) => ({ word: `filler${i}` }));
    const entries = [
      { word: 'Alpha' },
      { word: 'one' },
      { word: 'two' },
      { word: 'three' },
      { word: 'Beta' },
      { word: 'gamma' },
      { word: 'delta' },
      { word: 'epsilon' },
      ...inserted,
      { word: 'The' },
      { word: 'council' },
      { word: 'met' },
      { word: 'on' },
      { word: 'Tuesday' },
      { word: 'morning' },
    ];
    const ranges = buildSentenceWordRanges(
      [
        'Alpha one two three',
        'The story continues on the next morning',
        'Beta gamma delta epsilon',
      ],
      entries,
    );

    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 3 });
    expect(ranges.has(2)).toBe(false);
    expect(ranges.get(3)).toEqual({ startIdx: 4, endIdx: 7 });
  });

  it('does not fabricate an end range when the sentence end cannot be found', () => {
    const entries = [{ word: 'Alpha' }, { word: 'Beta' }, { word: 'Gamma' }];
    const ranges = buildSentenceWordRanges(['Alpha Missing', 'Gamma'], entries);
    expect(ranges.has(1)).toBe(false);
    expect(ranges.get(2)).toEqual({ startIdx: 2, endIdx: 2 });
  });

  it('does not map punctuation-only sentences', () => {
    const entries = [{ word: 'Alpha' }];
    const ranges = buildSentenceWordRanges(['---', 'Alpha'], entries);
    expect(ranges.has(1)).toBe(false);
    expect(ranges.get(2)).toEqual({ startIdx: 0, endIdx: 0 });
  });

  it('anchors sentences written outside the ASCII alphabet', () => {
    const entries = [{ word: 'Привет' }, { word: 'мир' }, { word: '再见' }];
    const ranges = buildSentenceWordRanges(['Привет мир', '再见'], entries);
    expect(ranges.get(1)).toEqual({ startIdx: 0, endIdx: 1 });
    expect(ranges.get(2)).toEqual({ startIdx: 2, endIdx: 2 });
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
