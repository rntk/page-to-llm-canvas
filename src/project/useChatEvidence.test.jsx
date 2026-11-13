// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatEvidenceId, isChatEvidence, useChatEvidence } from './useChatEvidence.js';

let container;
let root;
let hook;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function Probe({ readPage, onValue }) {
  const value = useChatEvidence(readPage);
  useEffect(() => {
    onValue(value);
  });
  return null;
}

async function mount(readPage = vi.fn()) {
  await act(async () =>
    root.render(
      <Probe
        readPage={readPage}
        onValue={(value) => {
          hook = value;
        }}
      />,
    ),
  );
  return readPage;
}

const range = (extra = {}) => ({
  startLine: 2,
  endLine: 3,
  label: 'Why',
  pageUrl: 'https://cats.test/',
  pageTitle: 'Cats',
  excerpt: ['Line two.', 'Line three.'],
  ...extra,
});

describe('useChatEvidence', () => {
  it('shows only the picked event, until closed or cleared', async () => {
    await mount();
    await act(async () => {
      hook.onClearHighlights();
      // Streamed and repainted ranges stay off the canvas.
      hook.onHighlight(range());
      // Article ranges without a page are not canvas evidence.
      hook.onHighlight({ startLine: 1, endLine: 1 }, { focus: true });
    });
    expect(hook.evidence).toEqual([]);

    await act(async () => hook.onHighlight(range(), { focus: true }));
    expect(hook.evidence.map((item) => [item.id, item.text])).toEqual([
      ['chat-evidence:https://cats.test/#2-3', 'Line two. Line three.'],
    ]);
    expect(isChatEvidence(hook.evidence[0])).toBe(true);
    expect(isChatEvidence({ id: 'e1' })).toBe(false);

    // Picking another event replaces the card.
    const five = range({ startLine: 5, endLine: 5, excerpt: ['Line five.'] });
    await act(async () => hook.onHighlight(five, { focus: true }));
    expect(hook.evidence.map((item) => item.id)).toEqual([chatEvidenceId(five)]);

    await act(async () => hook.dismiss(chatEvidenceId(five)));
    expect(hook.evidence).toEqual([]);

    await act(async () => hook.onHighlight(five, { focus: true }));
    await act(async () => hook.onClearHighlights());
    expect(hook.evidence).toEqual([]);
  });

  it('reads the page for a highlight saved without its lines', async () => {
    const readPage = await mount(
      vi.fn(async () => ({ sentences: ['One.', 'Two.', 'Three.', 'Four.'] })),
    );
    await act(async () => hook.onHighlight(range({ excerpt: undefined }), { focus: true }));
    expect(readPage).toHaveBeenCalledWith('https://cats.test/');
    expect(hook.evidence[0]).toMatchObject({
      id: chatEvidenceId(range()),
      text: 'Two. Three.',
      loading: false,
    });
  });

  it('reports a page that can no longer be read', async () => {
    await mount(vi.fn(async () => Promise.reject(new Error('Tab closed'))));
    await act(async () => hook.onHighlight(range({ excerpt: [] }), { focus: true }));
    expect(hook.evidence[0]).toMatchObject({ loading: false, error: 'Tab closed' });
  });
});
