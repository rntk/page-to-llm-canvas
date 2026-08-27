// @vitest-environment happy-dom
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useTopicSelection } from './useTopicSelection.js';

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const apiRef = { current: null };

  function Harness() {
    apiRef.current = useTopicSelection();
    return null;
  }

  act(() => root.render(createElement(Harness)));
  return {
    apiRef,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cleanups = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

const technology = { path: 'Technology', cardKey: 'Technology#0#1' };
const science = { path: 'Science', cardKey: 'Science#0#0' };

describe('useTopicSelection', () => {
  it('stores complete targets atomically and toggles the exact selected target', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.toggleTopic(technology));
    expect(apiRef.current.selectedTarget).toEqual(technology);
    expect(apiRef.current.selectedTarget).not.toBe(technology);

    act(() => apiRef.current.toggleTopic(technology));
    expect(apiRef.current.selectedTarget).toBeNull();
  });

  it('prefers hover for the active target and restores selection when it leaves', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.selectTopic(technology));
    act(() => apiRef.current.enterTopic(science));
    expect(apiRef.current.activeTarget).toEqual(science);

    act(() => apiRef.current.leaveTopic(science));
    expect(apiRef.current.activeTarget).toEqual(technology);
  });

  it('keeps hover when a different topic leaves', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.enterTopic(science));
    act(() => apiRef.current.leaveTopic(technology));

    expect(apiRef.current.hoveredTarget).toEqual(science);
  });

  // The summary view and the hierarchy rail both write hover state, and their
  // card keys come from separate builders. A leave that cannot name the same
  // key must still release the hover, or it latches until an unrelated enter.
  it('releases hover on a path match when either side has no card key', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.enterTopic(science));
    act(() => apiRef.current.leaveTopic({ path: 'Science', cardKey: null }));
    expect(apiRef.current.hoveredTarget).toBeNull();

    act(() => apiRef.current.enterTopic({ path: 'Science' }));
    act(() => apiRef.current.leaveTopic(science));
    expect(apiRef.current.hoveredTarget).toBeNull();
  });

  it('clears hover on a path match even when the card keys disagree', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.enterTopic(science));
    act(() => apiRef.current.leaveTopic({ path: 'Science', cardKey: 'Science#0#1' }));

    expect(apiRef.current.hoveredTarget).toBeNull();
  });

  // getTopicNavigationCardKey() resolves to null for keyless cards, so a
  // path-only target must still select rather than silently doing nothing.
  it('accepts targets without a card key and matches them by path', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.selectTopic({ path: 'Technology' }));
    expect(apiRef.current.selectedTarget).toEqual({ path: 'Technology', cardKey: null });

    act(() => apiRef.current.enterTopic({ path: 'Science', cardKey: undefined }));
    expect(apiRef.current.hoveredTarget).toEqual({ path: 'Science', cardKey: null });
  });

  it('ignores targets that name no path', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.selectTopic({ cardKey: 'Technology#0#1' }));
    act(() => apiRef.current.enterTopic(null));
    act(() => apiRef.current.toggleTopic(undefined));

    expect(apiRef.current.selectedTarget).toBeNull();
    expect(apiRef.current.hoveredTarget).toBeNull();
  });

  // copyTopicTarget() mints a fresh object per call, so the setters must reuse
  // the previous object when nothing changed — memoized consumers (this state is
  // passed straight to React.memo'd components) re-render on any new identity.
  it('preserves state identity when the same target is re-entered', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.enterTopic(science));
    const firstHovered = apiRef.current.hoveredTarget;

    act(() => apiRef.current.enterTopic({ ...science }));

    expect(apiRef.current.hoveredTarget).toBe(firstHovered);
  });

  it('preserves selection identity when the same target is re-selected', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.selectTopic(technology));
    const firstSelected = apiRef.current.selectedTarget;

    act(() => apiRef.current.selectTopic({ ...technology }));

    expect(apiRef.current.selectedTarget).toBe(firstSelected);
  });

  it('clears hover and selection together', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.selectTopic(technology));
    act(() => apiRef.current.enterTopic(science));
    act(() => apiRef.current.clearSelection());

    expect(apiRef.current.selectedTarget).toBeNull();
    expect(apiRef.current.hoveredTarget).toBeNull();
    expect(apiRef.current.activeTarget).toBeNull();
  });
});
