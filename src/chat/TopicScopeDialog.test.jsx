// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TopicScopeDialog from './TopicScopeDialog.jsx';

let roots = [];

function renderIn(parent) {
  const opener = document.createElement('button');
  opener.textContent = 'Open topics';
  parent.append(opener);
  const container = document.createElement('div');
  parent.append(container);
  opener.focus();

  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <TopicScopeDialog paths={['Alpha']} scope={[]} onApply={() => {}} onClose={() => {}} />,
    );
  });
  return { container, opener, root };
}

beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function showModal() {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function close() {
    this.removeAttribute('open');
  });
});

afterEach(() => {
  act(() => roots.forEach((root) => root.unmount()));
  roots = [];
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('TopicScopeDialog focus management', () => {
  it('focuses search and restores the opener in the document', () => {
    const { container, opener, root } = renderIn(document.body);
    const search = container.querySelector('input[type="search"]');

    expect(document.activeElement).toBe(search);
    act(() => root.unmount());
    roots = roots.filter((mountedRoot) => mountedRoot !== root);
    expect(document.activeElement).toBe(opener);
  });

  it('focuses search and restores the opener in a shadow root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const { container, opener, root } = renderIn(shadowRoot);
    const search = container.querySelector('input[type="search"]');

    expect(document.activeElement).toBe(host);
    expect(shadowRoot.activeElement).toBe(search);
    act(() => root.unmount());
    roots = roots.filter((mountedRoot) => mountedRoot !== root);
    expect(document.activeElement).toBe(host);
    expect(shadowRoot.activeElement).toBe(opener);
  });
});
