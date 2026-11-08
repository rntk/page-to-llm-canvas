// @vitest-environment happy-dom
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectMerge } from './useProjectMerge.js';

let container;
let root;
let latest;

function Harness(props) {
  const value = useProjectMerge(props);
  useEffect(() => {
    latest = value;
  });
  return null;
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  latest = null;
});

describe('useProjectMerge', () => {
  it('ignores a second build started before the first re-renders', async () => {
    let resolve;
    const buildTopics = vi.fn(() => new Promise((res) => (resolve = res)));
    const refresh = vi.fn();
    await act(async () =>
      root.render(
        <Harness
          buildTopics={buildTopics}
          stopTopics={vi.fn()}
          merge={undefined}
          refresh={refresh}
          showTopics={vi.fn()}
        />,
      ),
    );

    // Both calls use the same render's closure, as two fast clicks would.
    const { build } = latest;
    await act(async () => {
      void build({ fresh: true });
      void build({ fresh: true });
    });
    expect(buildTopics).toHaveBeenCalledTimes(1);
    expect(latest.pending).toBe(true);

    await act(async () => resolve());
    expect(latest.pending).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      void latest.build({ fresh: true });
    });
    expect(buildTopics).toHaveBeenCalledTimes(2);
  });
});
