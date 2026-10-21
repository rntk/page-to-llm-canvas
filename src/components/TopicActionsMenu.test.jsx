// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TopicActionsMenu from './TopicActionsMenu.jsx';
import { createResplitAction } from '../shared/runtime/topicResplit.js';
import { completeResplitDialog, resplitDialogRoot } from '../../test/resplitDialog.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let root;
let container;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

function openResplit(request = vi.fn(async () => ({ ok: true }))) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <TopicActionsMenu
        topic={{ path: 'Science', startSentence: 1, endSentence: 2 }}
        actions={[createResplitAction({ request })]}
      />,
    ),
  );
  const trigger = container.querySelector('button');
  act(() => trigger.click());
  // Match the browser's focus and pointer event ordering, including events
  // before React has committed the pending state.
  act(() => {
    document.querySelector('[role="menuitem"]').click();
    resplitDialogRoot()
      .querySelector('textarea')
      .dispatchEvent(
        new Event('pointerdown', {
          bubbles: true,
          composed: true,
        }),
      );
  });
  return { trigger, request };
}

describe('TopicActionsMenu with a resplit dialog', () => {
  it.each(['pointer', 'escape'])('restores trigger focus after %s cancellation', async (method) => {
    const { trigger, request } = openResplit();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => {
      if (method === 'pointer') {
        const cancel = resplitDialogRoot().querySelector('button[type="button"]');
        cancel.dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
        cancel.click();
      } else {
        const dialog = resplitDialogRoot().querySelector('dialog');
        dialog.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }),
        );
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
      }
    });
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('restores trigger focus after a submitted resplit is accepted', async () => {
    const { trigger, request } = openResplit();
    await act(async () => completeResplitDialog({ splittingInstructions: 'Split by study.' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it.each([
    [{ ok: false, error: 'Provider unavailable.' }, 'Provider unavailable.'],
    [{ ok: true, stale: true }, 'This topic changed. Refresh the view and try again.'],
    [new Error('Network failed.'), 'Network failed.'],
  ])('keeps errors visible after interacting with the dialog: %j', async (response, message) => {
    const request = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    const { trigger } = openResplit(request);
    const dialog = resplitDialogRoot();
    act(() =>
      dialog
        .querySelector('textarea')
        .dispatchEvent(new Event('wheel', { bubbles: true, composed: true })),
    );
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => completeResplitDialog({ summaryInstructions: 'Focus on measurements.' }));
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({ summaryInstructions: 'Focus on measurements.' }),
    );
    const menu = document.querySelector('[role="menu"]');
    expect(menu.querySelector('[role="alert"]').textContent).toBe(message);
    expect(menu.querySelector('[role="menuitem"]').disabled).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector('[role="menuitem"]'));
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
