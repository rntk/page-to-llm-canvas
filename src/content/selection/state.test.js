// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  BLOCK_SNIPPET_LENGTH,
  BLOCK_SNIPPET_TITLE_LENGTH,
  buildBlockSnippets,
  canStepUpElement,
  createSelectedEntry,
  getBlockText,
  moveSelectedEntry,
  removeSelectedEntry,
  renumberSelectedEntries,
  selectedBlocksForToolbar,
  stepUpSelectedEntry,
  truncateSnippet,
} from './state.js';

function entries(names) {
  return names.map((name, index) => ({ el: { name }, originalNumber: index + 10 }));
}

describe('selection state', () => {
  it('renumbers entries without changing their element references', () => {
    const input = entries(['a', 'b']);
    const result = renumberSelectedEntries(input);
    expect(result).toBe(input);
    expect(result[0]).toBe(input[0]);
    expect(result[1]).toBe(input[1]);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2]);
    expect(result.map((entry) => entry.el)).toEqual(input.map((entry) => entry.el));
  });

  it('removes an entry and closes numbering gaps', () => {
    const result = removeSelectedEntry(entries(['a', 'b', 'c']), 1);
    expect(result.map((entry) => entry.el.name)).toEqual(['a', 'c']);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });

  it('moves an entry and renumbers the resulting order', () => {
    const input = entries(['a', 'b', 'c']);
    const movedEntry = input[0];
    const result = moveSelectedEntry(input, 0, 2);
    expect(result.map((entry) => entry.el.name)).toEqual(['b', 'c', 'a']);
    expect(result[2]).toBe(movedEntry);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2, 3]);
  });

  it('normalizes numbering for invalid moves and removals', () => {
    expect(
      moveSelectedEntry(entries(['a', 'b']), 0, 0).map((entry) => entry.originalNumber),
    ).toEqual([1, 2]);
    expect(
      removeSelectedEntry(entries(['a', 'b']), 5).map((entry) => entry.originalNumber),
    ).toEqual([1, 2]);
  });

  it('builds the toolbar view model from selected entries', () => {
    expect(selectedBlocksForToolbar(renumberSelectedEntries(entries(['a', 'b'])))).toEqual([
      { id: 1, originalNumber: 1, canStepUp: true, snippet: '', snippetTitle: '' },
      { id: 2, originalNumber: 2, canStepUp: true, snippet: '', snippetTitle: '' },
    ]);
  });

  it('includes short and long text snippets in the toolbar view model', () => {
    const longText = `Hello selection with plenty of words to exceed ${BLOCK_SNIPPET_LENGTH} chars`;
    const input = renumberSelectedEntries([{ el: { textContent: longText } }]);
    const [block] = selectedBlocksForToolbar(input);
    expect(block.snippet).toBe(truncateSnippet(longText, BLOCK_SNIPPET_LENGTH));
    expect(block.snippetTitle).toBe(truncateSnippet(longText, BLOCK_SNIPPET_TITLE_LENGTH));
    expect(block.snippet.length).toBeLessThanOrEqual(BLOCK_SNIPPET_LENGTH + 1);
  });

  it('collapses whitespace and truncates block text for snippets', () => {
    expect(getBlockText({ textContent: '  hello\n\t  world  ' })).toBe('hello world');
    expect(getBlockText(null)).toBe('');
    expect(getBlockText({})).toBe('');
    expect(truncateSnippet('short', 30)).toBe('short');
    expect(truncateSnippet('hello world', 5)).toBe('hello…');
    expect(buildBlockSnippets(null)).toEqual({ snippet: '', snippetTitle: '' });
    expect(buildBlockSnippets({ textContent: '   ' })).toEqual({
      snippet: '',
      snippetTitle: '',
    });
  });

  it('derives canStepUp per entry from the provided predicate', () => {
    const input = renumberSelectedEntries(entries(['a', 'b']));
    const result = selectedBlocksForToolbar(input, (el) => el.name !== 'b');
    expect(result.map((block) => block.canStepUp)).toEqual([true, false]);
  });

  it('avoids splitting surrogate pairs during truncation', () => {
    const textWithSurrogate = '12345\uD83D\uDE00';
    const result = truncateSnippet(textWithSurrogate, 6);
    expect(result).toBe('12345…');
    expect(/[\uD800-\uDBFF]…$/.test(result)).toBe(false);

    expect(truncateSnippet(textWithSurrogate, 7)).toBe('12345\uD83D\uDE00');
  });

  it('skips non-visible subtrees including script, style, noscript, template, and hidden elements', () => {
    const container = document.createElement('article');

    const style = document.createElement('style');
    style.textContent = '.hero { margin: 0; }';
    container.appendChild(style);

    const script = document.createElement('script');
    script.textContent = '{"@context": "https://schema.org"}';
    container.appendChild(script);

    const noscript = document.createElement('noscript');
    noscript.textContent = 'Enable JS to view';
    container.appendChild(noscript);

    const template = document.createElement('template');
    template.textContent = 'Template fallback';
    container.appendChild(template);

    const hiddenDiv = document.createElement('div');
    hiddenDiv.setAttribute('hidden', '');
    hiddenDiv.textContent = 'Hidden secret';
    container.appendChild(hiddenDiv);

    const displayNoneDiv = document.createElement('div');
    displayNoneDiv.style.display = 'none';
    displayNoneDiv.textContent = 'Display none text';
    container.appendChild(displayNoneDiv);

    const title = document.createElement('h1');
    title.textContent = 'Visible Headline';
    container.appendChild(title);

    const para = document.createElement('p');
    para.textContent = 'First visible paragraph of the article.';
    container.appendChild(para);

    expect(getBlockText(container)).toBe(
      'Visible Headline First visible paragraph of the article.',
    );
  });

  it('separates block-level siblings with a space but keeps inline elements joined', () => {
    const container = document.createElement('article');
    container.innerHTML =
      '<p>un<em>believable</em> <a href="#">link</a>text</p><p>Next paragraph</p><div><span>Deep</span></div>';
    expect(getBlockText(container)).toBe('unbelievable linktext Next paragraph Deep');
  });

  it('does not let leading empty blocks consume the snippet budget', () => {
    const container = document.createElement('div');
    let html = '';
    for (let i = 0; i < 81; i++) {
      html += '\n  <div><img alt=""></div>';
    }
    const sentence =
      'Real headline text that must survive pretty-printed indentation before it in the markup.';
    html += `\n  <p>${sentence}</p>\n`;
    container.innerHTML = html;
    expect(getBlockText(container)).toContain(sentence);
  });

  it('stops walking once enough text has been collected for the title snippet', () => {
    const container = document.createElement('div');
    for (let i = 0; i < 200; i++) {
      const p = document.createElement('p');
      p.textContent = `Paragraph ${i} with some filler words`;
      container.appendChild(p);
    }
    let reads = 0;
    const lastText = container.lastChild.firstChild;
    Object.defineProperty(lastText, 'nodeValue', {
      get() {
        reads += 1;
        return 'never reached';
      },
    });
    const text = getBlockText(container);
    expect(text.startsWith('Paragraph 0 with some filler words Paragraph 1')).toBe(true);
    expect(text.length).toBeLessThan(1000);
    expect(reads).toBe(0);
  });

  it('reuses precomputed snippets and caches snippets on entry', () => {
    let readCount = 0;
    const el = {
      get textContent() {
        readCount += 1;
        return 'Lazy evaluated text';
      },
    };
    const entry = createSelectedEntry(el, 1);
    expect(readCount).toBe(1);
    expect(entry.snippet).toBe('Lazy evaluated text');

    const blocks1 = selectedBlocksForToolbar([entry]);
    expect(blocks1[0].snippet).toBe('Lazy evaluated text');
    expect(readCount).toBe(1);

    const blocks2 = selectedBlocksForToolbar([entry]);
    expect(blocks2[0].snippet).toBe('Lazy evaluated text');
    expect(readCount).toBe(1);
  });
});

describe('element traversal', () => {
  it('detects when an element can step up to its parent', () => {
    const body = { nodeName: 'BODY' };
    const html = { nodeName: 'HTML' };
    const parent = { parentElement: body };
    const child = { parentElement: parent };

    expect(canStepUpElement(null, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(body, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(html, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(parent, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(child, { body, documentElement: html })).toBe(true);
  });

  it('steps up to the parent without duplicating an already selected parent', () => {
    const body = { nodeName: 'BODY' };
    const parent = { id: 'parent', parentElement: body };
    const child = { id: 'child', parentElement: parent };
    const sibling = { id: 'sibling', parentElement: body };

    const input = [
      { el: parent, originalNumber: 1 },
      { el: child, originalNumber: 2 },
      { el: sibling, originalNumber: 3 },
    ];

    const result = stepUpSelectedEntry(input, 1, {
      body,
      documentElement: { nodeName: 'HTML' },
    });

    expect(result.oldElement).toBe(child);
    expect(result.newElement).toBe(parent);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.el)).toEqual([parent, sibling]);
    expect(result.entries.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });

  it('steps up to the parent in place when the parent is not already selected', () => {
    const body = { nodeName: 'BODY' };
    const parent = { id: 'parent', parentElement: body };
    const child = { id: 'child', parentElement: parent };
    const sibling = { id: 'sibling', parentElement: body };

    const input = [
      { el: child, originalNumber: 1 },
      { el: sibling, originalNumber: 2 },
    ];

    const result = stepUpSelectedEntry(input, 0, {
      body,
      documentElement: { nodeName: 'HTML' },
    });

    expect(result.oldElement).toBe(child);
    expect(result.newElement).toBe(parent);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].el).toBe(parent);
    expect(result.entries[1].el).toBe(sibling);
    expect(result.entries.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });

  it('updates cached snippets when stepping up to a parent', () => {
    const parent = document.createElement('section');
    parent.textContent = 'Parent';
    document.body.appendChild(parent);

    const child = document.createElement('div');
    child.textContent = 'Child';
    parent.appendChild(child);

    const input = [createSelectedEntry(child, 1)];
    expect(input[0].snippet).toBe('Child');

    const result = stepUpSelectedEntry(input, 0);

    expect(result.entries[0].el).toBe(parent);
    expect(result.entries[0].snippet).toBe('Parent Child');

    parent.remove();
  });
});
