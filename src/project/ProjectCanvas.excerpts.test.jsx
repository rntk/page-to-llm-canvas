// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { CARD_HEIGHT, EXCERPT_GAP, EXCERPT_INDENT } from './canvasLayout.js';

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

const tabs = [
  { id: 1, title: 'One', url: 'https://one.test/a#top' },
  { id: 2, title: 'Two', url: 'https://two.test/' },
];
const excerpts = [
  { id: 'e1', url: 'https://one.test/a', title: 'One (old)', text: 'First passage.' },
  { id: 'e2', url: 'https://gone.test/', title: 'Gone page', text: 'Orphan passage.' },
];

const card = (id) => container.querySelector(`[data-excerpt-id="${id}"].excerpt-card`);
const nodeOf = (element) => element.closest('.canvas-node');
const button = (label) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );

async function render(props = {}) {
  const tabsHost = { activateTab: vi.fn(async () => {}) };
  const onDeleteExcerpt = vi.fn(async () => {});
  const renderExcerptChat = vi.fn((excerpt) => (
    <aside className="page-chat-drawer" data-chat-for={excerpt.id} />
  ));
  const view = (extra) => (
    <ProjectCanvas
      tabs={tabs}
      excerpts={excerpts}
      tabsHost={tabsHost}
      renderExcerptChat={renderExcerptChat}
      onDeleteExcerpt={onDeleteExcerpt}
      {...props}
      {...extra}
    />
  );
  await act(async () => root.render(view()));
  return {
    tabsHost,
    onDeleteExcerpt,
    renderExcerptChat,
    rerender: (extra) => root.render(view(extra)),
  };
}

describe('ProjectCanvas excerpts', () => {
  it('stacks an excerpt under its page card and links them', async () => {
    await render();
    expect(nodeOf(card('e1')).style.transform).toBe(
      `translate(${EXCERPT_INDENT}px, ${CARD_HEIGHT + EXCERPT_GAP}px)`,
    );
    expect(container.querySelector('.excerpt-link[data-excerpt-id="e1"]')).not.toBeNull();
    // The orphan has no page card, so no connector.
    expect(container.querySelector('.excerpt-link[data-excerpt-id="e2"]')).toBeNull();
    expect(card('e2').classList.contains('is-detached')).toBe(true);
  });

  it('names the page and switches to its tab', async () => {
    const { tabsHost } = await render();
    const source = card('e1').querySelector('.excerpt-card-source');
    expect(source.textContent).toContain('One');
    await act(async () => source.click());
    expect(tabsHost.activateTab).toHaveBeenCalledWith(1);
    expect(card('e2').querySelector('.excerpt-card-source').disabled).toBe(true);
    expect(card('e2').querySelector('.excerpt-card-source').textContent).toContain('gone.test');
  });

  it('unfolds the chat of a focused excerpt once, and on demand', async () => {
    const { rerender } = await render({ focusExcerptId: 'e1' });
    expect(container.querySelector('[data-chat-for="e1"]')).not.toBeNull();
    await act(async () => button('Fold chat for the excerpt from One').click());
    expect(container.querySelector('[data-chat-for="e1"]')).toBeNull();
    // The same focus id again (a stale view) does not reopen it.
    await act(async () => rerender({ focusExcerptId: 'e1' }));
    expect(container.querySelector('[data-chat-for="e1"]')).toBeNull();
    await act(async () => button('Unfold chat for the excerpt from Gone page').click());
    expect(container.querySelector('[data-chat-for="e2"]')).not.toBeNull();
  });

  it('reports a focus id as handled once', async () => {
    const onFocusHandled = vi.fn();
    const { rerender } = await render({ focusExcerptId: 'e1', onFocusHandled });
    await act(async () => rerender({ focusExcerptId: 'e1', onFocusHandled }));
    expect(onFocusHandled).toHaveBeenCalledTimes(1);
    expect(onFocusHandled).toHaveBeenCalledWith('e1');
  });

  it('follows its page when the page card is dragged', async () => {
    await render();
    const header = container.querySelector('[data-tab-id="1"] .tab-card-header');
    await act(async () => {
      header.dispatchEvent(
        new MouseEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, button: 0 }),
      );
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 50 }));
      window.dispatchEvent(new MouseEvent('pointerup', {}));
    });
    expect(nodeOf(card('e1')).style.transform).toBe(
      `translate(${EXCERPT_INDENT + 100}px, ${CARD_HEIGHT + EXCERPT_GAP + 50}px)`,
    );
  });

  it('deletes an excerpt through the handler', async () => {
    const { onDeleteExcerpt } = await render();
    await act(async () => card('e1').querySelector('.excerpt-card-footer button').click());
    expect(onDeleteExcerpt).toHaveBeenCalledWith(excerpts[0]);
  });
});
