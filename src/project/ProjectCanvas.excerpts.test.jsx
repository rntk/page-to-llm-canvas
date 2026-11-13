// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectCanvas } from './ProjectCanvas.jsx';
import { CARD_HEIGHT, EXCERPT_GAP, EXCERPT_HEIGHT, EXCERPT_INDENT } from './canvasLayout.js';

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

  it('waits for the focused excerpt and its chat renderer before acknowledging', async () => {
    const onFocusHandled = vi.fn();
    const { rerender, renderExcerptChat } = await render({
      focusExcerptId: 'e1',
      excerpts: [],
      onFocusHandled,
    });
    expect(onFocusHandled).not.toHaveBeenCalled();
    await act(async () => rerender({ excerpts, renderExcerptChat: undefined }));
    expect(onFocusHandled).not.toHaveBeenCalled();
    await act(async () => rerender({ excerpts, renderExcerptChat }));
    expect(container.querySelector('[data-chat-for="e1"]')).not.toBeNull();
    expect(onFocusHandled).toHaveBeenCalledExactlyOnceWith('e1');
  });

  it('does not repeat a handled focus when its acknowledgement callback changes', async () => {
    const onFocusHandled = vi.fn();
    const { rerender } = await render({ focusExcerptId: 'e1', onFocusHandled });
    await act(async () => button('Fold chat for the excerpt from One').click());
    const nextAcknowledgement = vi.fn();
    await act(async () => rerender({ onFocusHandled: nextAcknowledgement }));
    expect(container.querySelector('[data-chat-for="e1"]')).toBeNull();
    expect(onFocusHandled).toHaveBeenCalledExactlyOnceWith('e1');
    expect(nextAcknowledgement).not.toHaveBeenCalled();
  });

  it('handles focus once when Strict Mode replays effects', async () => {
    const onFocusHandled = vi.fn();
    await act(async () =>
      root.render(
        <React.StrictMode>
          <ProjectCanvas
            tabs={tabs}
            excerpts={excerpts}
            tabsHost={{}}
            focusExcerptId="e1"
            onFocusHandled={onFocusHandled}
            renderExcerptChat={(excerpt) => <aside data-chat-for={excerpt.id} />}
          />
        </React.StrictMode>,
      ),
    );
    expect(container.querySelector('[data-chat-for="e1"]')).not.toBeNull();
    expect(onFocusHandled).toHaveBeenCalledExactlyOnceWith('e1');
  });

  it('raises an excerpt chat above other chats when opened or interacted with', async () => {
    await render({
      renderPageChat: () => <aside className="page-chat-drawer" />,
    });
    const pageNode = container.querySelector('[data-tab-id="1"]').closest('.canvas-node');
    const excerptNode = nodeOf(card('e1'));
    await act(async () => button('Unfold chat for One').click());
    expect(pageNode.style.zIndex).toBe('3');
    await act(async () => button('Unfold chat for the excerpt from One').click());
    expect(pageNode.style.zIndex).toBe('2');
    expect(excerptNode.style.zIndex).toBe('3');
    await act(async () =>
      pageNode
        .querySelector('aside')
        .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    );
    expect(pageNode.style.zIndex).toBe('3');
    expect(excerptNode.style.zIndex).toBe('2');
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

  it('updates the dragged page, its excerpt and connector once per frame without rendering', async () => {
    const frames = new Map();
    let frameId = 0;
    const requestFrame = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    try {
      const renderPageChat = vi.fn(() => <aside />);
      await render({ renderPageChat });
      await act(async () => button('Unfold chat for One').click());
      const header = container.querySelector('[data-tab-id="1"] .tab-card-header');
      const path = container.querySelector('.excerpt-link[data-excerpt-id="e1"]');
      const originalPath = path.getAttribute('d');
      await act(async () => {
        header.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      });
      renderPageChat.mockClear();
      await act(async () => {
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 20 }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 100, clientY: 50 }));
      });
      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(renderPageChat).not.toHaveBeenCalled();
      expect(path.getAttribute('d')).toBe(originalPath);
      await act(async () => {
        const callback = frames.values().next().value;
        frames.clear();
        callback();
      });
      expect(nodeOf(card('e1')).style.transform).toBe(
        `translate(${EXCERPT_INDENT + 100}px, ${CARD_HEIGHT + EXCERPT_GAP + 50}px)`,
      );
      expect(path.getAttribute('d')).not.toBe(originalPath);
      expect(renderPageChat).not.toHaveBeenCalled();
      await act(async () => window.dispatchEvent(new MouseEvent('pointerup')));
      expect(renderPageChat).toHaveBeenCalled();
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('flushes the latest drag position when released before its frame', async () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(123);
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      await render();
      const header = container.querySelector('[data-tab-id="1"] .tab-card-header');
      await act(async () => {
        header.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 30 }));
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
      expect(cancelFrame).toHaveBeenCalledWith(123);
      expect(nodeOf(card('e1')).style.transform).toBe(
        `translate(${EXCERPT_INDENT + 80}px, ${CARD_HEIGHT + EXCERPT_GAP + 30}px)`,
      );
    } finally {
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  it('keeps a separately dragged excerpt in place when its page moves', async () => {
    await render();
    const drag = async (header, dx, dy) =>
      act(async () => {
        header.dispatchEvent(
          new MouseEvent('pointerdown', {
            bubbles: true,
            clientX: 0,
            clientY: 0,
            button: 0,
          }),
        );
        window.dispatchEvent(new MouseEvent('pointermove', { clientX: dx, clientY: dy }));
        window.dispatchEvent(new MouseEvent('pointerup'));
      });
    await drag(card('e1').querySelector('.excerpt-card-header'), 30, 20);
    const movedPosition = nodeOf(card('e1')).style.transform;
    expect(movedPosition).toBe(
      `translate(${EXCERPT_INDENT + 30}px, ${CARD_HEIGHT + EXCERPT_GAP + 20}px)`,
    );
    await drag(container.querySelector('[data-tab-id="1"] .tab-card-header'), 100, 50);
    expect(nodeOf(card('e1')).style.transform).toBe(movedPosition);
  });

  it('lets excerpt text scroll without styling classes and still supports Ctrl+wheel zoom', async () => {
    await render();
    const text = card('e1').querySelector('blockquote');
    text.removeAttribute('class');
    const layer = container.querySelector('[data-testid="canvas-layer"]');
    const before = layer.style.transform;
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    await act(async () => text.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(layer.style.transform).toBe(before);

    const ctrl = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 });
    // Happy DOM ignores modifier keys in the WheelEvent init dictionary.
    Object.defineProperty(ctrl, 'ctrlKey', { value: true });
    await act(async () => text.dispatchEvent(ctrl));
    expect(ctrl.defaultPrevented).toBe(true);
    expect(layer.style.transform).not.toBe(before);
  });

  it('deletes an excerpt through the handler', async () => {
    const { onDeleteExcerpt } = await render();
    await act(async () => card('e1').querySelector('.excerpt-card-footer button').click());
    expect(onDeleteExcerpt).toHaveBeenCalledWith(excerpts[0]);
  });

  it('stacks chat evidence after the excerpts under its page, linked, with Close only', async () => {
    const evidence = {
      id: 'chat-evidence:https://one.test/a#2-3',
      url: 'https://one.test/a',
      title: 'One',
      text: 'Cited lines.',
      label: 'Why',
      startLine: 2,
      endLine: 3,
    };
    const onDismissChatEvidence = vi.fn();
    await render({ chatEvidence: [evidence], onDismissChatEvidence });
    const evidenceCard = card(evidence.id);
    expect(evidenceCard.classList.contains('is-chat-evidence')).toBe(true);
    expect(evidenceCard.textContent).toContain('Chat evidence');
    expect(evidenceCard.querySelector('blockquote').textContent).toBe('Cited lines.');
    expect(evidenceCard.textContent).toContain('Why · Lines 2–3');
    expect(evidenceCard.textContent).not.toContain('Delete');
    expect(nodeOf(evidenceCard).querySelector('.page-chat-fold')).toBeNull();
    // Second in tab 1's stack, after the saved excerpt.
    expect(nodeOf(evidenceCard).style.transform).toBe(
      `translate(${EXCERPT_INDENT}px, ${CARD_HEIGHT + EXCERPT_GAP + EXCERPT_HEIGHT + EXCERPT_GAP}px)`,
    );
    const link = container.querySelector(`.excerpt-link[data-excerpt-id="${evidence.id}"]`);
    expect(link.classList.contains('is-chat-evidence')).toBe(true);

    await act(async () => button('Close chat evidence').click());
    expect(onDismissChatEvidence).toHaveBeenCalledWith(evidence.id);
  });
});
