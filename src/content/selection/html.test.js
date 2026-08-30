// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCapture } from './html.js';

describe('buildCapture HTML snapshot', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('clones elements and strips highlight classes from root and descendants', () => {
    const host = document.createElement('section');
    host.classList.add('pagetollm-selected');
    const child = document.createElement('p');
    child.classList.add('pagetollm-element-highlight', 'keep');
    host.appendChild(child);
    container.appendChild(host);

    const html = buildCapture([host]).html;
    expect(html).toContain('<section');
    expect(html).not.toContain('pagetollm-selected');
    expect(html).not.toContain('pagetollm-element-highlight');
    expect(html).toContain('class="keep"');
  });

  it('joins multiple elements with newlines', () => {
    const a = document.createElement('span');
    a.textContent = 'A';
    const b = document.createElement('span');
    b.textContent = 'B';
    const html = buildCapture([a, b]).html;
    expect(html.split('\n')).toHaveLength(2);
    expect(html).toContain('>A<');
    expect(html).toContain('>B<');
  });

  it('returns empty string for empty input', () => {
    expect(buildCapture([]).html).toBe('');
  });
});

describe('buildCapture', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('does not insert spaces between adjacent inline text nodes', () => {
    const root = document.createElement('div');
    const first = document.createElement('span');
    first.textContent = 'hel';
    const second = document.createElement('span');
    second.textContent = 'lo';
    root.append(first, second);
    container.appendChild(root);

    expect(buildCapture([root]).capturedText).toBe('hello');
  });

  it('preserves whitespace-only nodes between inline text', () => {
    const root = document.createElement('p');
    root.innerHTML = '<b>foo</b> <i>bar</i>';
    container.appendChild(root);

    expect(buildCapture([root]).capturedText).toBe('foo bar');
  });

  it('uses one newline between block-level siblings', () => {
    const root = document.createElement('div');
    const first = document.createElement('p');
    first.style.display = 'block';
    first.textContent = 'first';
    const second = document.createElement('p');
    second.style.display = 'block';
    second.textContent = 'second';
    root.append(first, second);
    container.appendChild(root);

    expect(buildCapture([root]).capturedText).toBe('first\nsecond');
  });

  it('omits hidden-attribute and display-none subtrees from text and HTML', () => {
    const root = document.createElement('div');
    const hidden = document.createElement('span');
    hidden.hidden = true;
    hidden.textContent = 'hidden attribute';
    const displayNone = document.createElement('span');
    displayNone.style.display = 'none';
    displayNone.textContent = 'display none';
    const visible = document.createElement('span');
    visible.textContent = 'visible';
    root.append(hidden, displayNone, visible);
    container.appendChild(root);

    const capture = buildCapture([root]);
    expect(capture.capturedText).toBe('visible');
    expect(capture.html).not.toContain('hidden attribute');
    expect(capture.html).not.toContain('display none');
    expect(capture.html).toContain('visible');
  });

  it('keeps a visible descendant of a visibility-hidden ancestor', () => {
    const root = document.createElement('div');
    const hiddenAncestor = document.createElement('div');
    hiddenAncestor.style.visibility = 'hidden';
    hiddenAncestor.append('not visible');
    const visibleDescendant = document.createElement('span');
    visibleDescendant.style.visibility = 'visible';
    visibleDescendant.textContent = 'visible descendant';
    hiddenAncestor.appendChild(visibleDescendant);
    root.appendChild(hiddenAncestor);
    container.appendChild(root);

    const capture = buildCapture([root]);
    expect(capture.capturedText).toBe('visible descendant');
    expect(capture.html).not.toContain('not visible');
    expect(capture.html).toContain('visible descendant');
  });

  it('omits opacity-zero text while retaining visible siblings', () => {
    const root = document.createElement('div');
    const transparent = document.createElement('span');
    transparent.style.opacity = '0';
    transparent.textContent = 'transparent';
    const visible = document.createElement('span');
    visible.textContent = 'opaque';
    root.append(transparent, visible);
    container.appendChild(root);

    const capture = buildCapture([root]);
    expect(capture.capturedText).toBe('opaque');
    expect(capture.html).not.toContain('transparent');
  });

  it('deduplicates duplicate and nested roots', () => {
    const root = document.createElement('article');
    const nested = document.createElement('p');
    nested.textContent = 'only once';
    root.appendChild(nested);
    container.appendChild(root);

    const capture = buildCapture([root, nested, root]);
    expect(capture.elements).toEqual([root]);
    expect(capture.html.match(/only once/g)).toHaveLength(1);
    expect(capture.capturedText).toBe('only once');
  });

  it('drops suppressed roots consistently from HTML, text, and selectors input', () => {
    const hidden = document.createElement('article');
    hidden.style.display = 'none';
    hidden.textContent = 'hidden root';
    const shown = document.createElement('article');
    shown.textContent = 'shown';
    container.append(hidden, shown);

    const capture = buildCapture([hidden, shown]);
    expect(capture.elements).toEqual([shown]);
    expect(capture.html).not.toContain('hidden root');
    expect(capture.capturedText).toBe('shown');
  });

  it('strips selection marker classes from the captured snapshot', () => {
    const root = document.createElement('section');
    root.className = 'pagetollm-selected article';
    const child = document.createElement('p');
    child.className = 'pagetollm-element-highlight paragraph';
    child.textContent = 'marked text';
    root.appendChild(child);
    container.appendChild(root);

    const capture = buildCapture([root]);
    expect(capture.html).not.toContain('pagetollm-selected');
    expect(capture.html).not.toContain('pagetollm-element-highlight');
    expect(capture.html).toContain('article');
    expect(capture.html).toContain('paragraph');
  });
});
