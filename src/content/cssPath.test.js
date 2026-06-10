// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCssPath, stripHighlightClasses } from './cssPath.js';

// ── buildCssPath ───────────────────────────────────────────────────────────

describe('buildCssPath', () => {
  let container;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it('returns empty string for non-Element input', () => {
    expect(buildCssPath(null)).toBe('');
    expect(buildCssPath(undefined)).toBe('');
    expect(buildCssPath('string')).toBe('');
    expect(buildCssPath(42)).toBe('');
  });

  it('builds path using id selector and stops at id', () => {
    const el = document.createElement('span');
    el.id = 'my-span';
    container.appendChild(el);
    const path = buildCssPath(el);
    expect(path).toMatch(/span#my-span$/);
    // Should not contain nth-of-type for the id element
    expect(path).not.toMatch(/span#my-span:nth-of-type/);
  });

  it('builds nth-of-type path for elements without id', () => {
    const p1 = document.createElement('p');
    const p2 = document.createElement('p');
    container.appendChild(p1);
    container.appendChild(p2);
    const path = buildCssPath(p2);
    expect(path).toContain('p:nth-of-type(2)');
  });

  it('builds nested path with > separator', () => {
    const outer = document.createElement('section');
    const inner = document.createElement('article');
    outer.appendChild(inner);
    container.appendChild(outer);
    const path = buildCssPath(inner);
    expect(path).toContain(' > ');
    expect(path).toMatch(/article:nth-of-type\(1\)$/);
  });

  it('stops path at an ancestor with an id', () => {
    const parent = document.createElement('div');
    parent.id = 'parent-id';
    const child = document.createElement('span');
    parent.appendChild(child);
    container.appendChild(parent);
    const path = buildCssPath(child);
    // Path should be anchored at the id-bearing ancestor
    expect(path).toMatch(/div#parent-id > span:nth-of-type\(1\)$/);
  });

  it('counts only same-tag siblings for nth-of-type', () => {
    const div = document.createElement('div');
    const span1 = document.createElement('span');
    const p = document.createElement('p');
    const span2 = document.createElement('span');
    div.appendChild(span1);
    div.appendChild(p);
    div.appendChild(span2);
    container.appendChild(div);
    // span2 is the 2nd span, not the 3rd child overall
    const path = buildCssPath(span2);
    expect(path).toContain('span:nth-of-type(2)');
  });

  it('returns a selector that can re-locate the element', () => {
    const section = document.createElement('section');
    section.id = 'locatable';
    const em = document.createElement('em');
    section.appendChild(em);
    container.appendChild(section);
    const path = buildCssPath(em);
    const found = document.querySelector(path);
    expect(found).toBe(em);
  });
});

// ── stripHighlightClasses ──────────────────────────────────────────────────

describe('stripHighlightClasses', () => {
  it('removes pagetollm-selected from the root element', () => {
    const el = document.createElement('div');
    el.classList.add('pagetollm-selected', 'keep-me');
    stripHighlightClasses(el);
    expect(el.classList.contains('pagetollm-selected')).toBe(false);
    expect(el.classList.contains('keep-me')).toBe(true);
  });

  it('removes pagetollm-element-highlight from the root element', () => {
    const el = document.createElement('div');
    el.classList.add('pagetollm-element-highlight');
    stripHighlightClasses(el);
    expect(el.classList.contains('pagetollm-element-highlight')).toBe(false);
  });

  it('removes highlight classes from descendant elements', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    child.classList.add('pagetollm-selected');
    parent.appendChild(child);
    stripHighlightClasses(parent);
    expect(child.classList.contains('pagetollm-selected')).toBe(false);
  });

  it('removes both classes from multiple descendants', () => {
    const parent = document.createElement('div');
    const a = document.createElement('span');
    a.classList.add('pagetollm-selected');
    const b = document.createElement('em');
    b.classList.add('pagetollm-element-highlight');
    parent.appendChild(a);
    parent.appendChild(b);
    stripHighlightClasses(parent);
    expect(a.classList.contains('pagetollm-selected')).toBe(false);
    expect(b.classList.contains('pagetollm-element-highlight')).toBe(false);
  });

  it('does not throw when classList is absent', () => {
    // Simulate an element-like object without classList
    const el = { querySelectorAll: undefined };
    expect(() => stripHighlightClasses(el)).not.toThrow();
  });
});
