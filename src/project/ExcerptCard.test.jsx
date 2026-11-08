// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExcerptCard } from './ExcerptCard.jsx';

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

const excerpt = {
  id: 'e1',
  url: 'https://example.test/page',
  title: 'Example page',
  text: 'A passage.',
};
const page = { id: 7, title: 'Example page' };

const render = (props) =>
  act(async () =>
    root.render(
      <ExcerptCard excerpt={excerpt} page={page} tabsHost={{}} onDelete={vi.fn()} {...props} />,
    ),
  );

describe('ExcerptCard', () => {
  it('reports failed activation and clears it when delete succeeds', async () => {
    const tabsHost = { activateTab: vi.fn().mockRejectedValue(new Error('no tab')) };
    const onDelete = vi.fn(async () => {});
    await render({ tabsHost, onDelete });
    await act(async () => container.querySelector('.excerpt-card-source').click());
    expect(container.querySelector('.excerpt-card-error').textContent).toBe(
      'Could not switch to tab',
    );
    await act(async () => container.querySelector('.excerpt-card-footer button').click());
    expect(container.querySelector('.excerpt-card-error')).toBeNull();
    expect(onDelete).toHaveBeenCalled();
  });

  it('clears a delete error when activation is retried', async () => {
    const tabsHost = { activateTab: vi.fn(async () => {}) };
    const onDelete = vi.fn().mockRejectedValue(new Error('cannot delete'));
    await render({ tabsHost, onDelete });
    await act(async () => container.querySelector('.excerpt-card-footer button').click());
    expect(container.querySelector('.excerpt-card-error').textContent).toBe(
      'Could not delete excerpt',
    );
    await act(async () => container.querySelector('.excerpt-card-source').click());
    expect(container.querySelector('.excerpt-card-error')).toBeNull();
    expect(tabsHost.activateTab).toHaveBeenCalledWith(7);
  });

  it('disables the source link when its page is detached', async () => {
    await render({ page: null });
    expect(container.querySelector('.excerpt-card-source').disabled).toBe(true);
  });
});
