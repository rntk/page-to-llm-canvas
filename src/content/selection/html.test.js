// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildHtml } from './html.js';

describe('buildHtml', () => {
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

    const html = buildHtml([host]);
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
    const html = buildHtml([a, b]);
    expect(html.split('\n')).toHaveLength(2);
    expect(html).toContain('>A<');
    expect(html).toContain('>B<');
  });

  it('returns empty string for empty input', () => {
    expect(buildHtml([])).toBe('');
  });
});
