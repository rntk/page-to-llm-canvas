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

describe('useTopicSelection', () => {
  it('selects a topic card and deselects it when clicked again', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.toggleTopicSelection('Technology', { key: 'Technology#0#1' }));
    expect(apiRef.current.selectedTopicKey).toBe('Technology');
    expect(apiRef.current.selectedTopicCardKey).toBe('Technology#0#1');

    act(() => apiRef.current.toggleTopicSelection('Technology', { key: 'Technology#0#1' }));
    expect(apiRef.current.selectedTopicKey).toBeNull();
    expect(apiRef.current.selectedTopicCardKey).toBeNull();
  });

  it('prefers hover state for the active topic and restores selection on leave', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.toggleTopicSelection('Technology', { key: 'Technology#0#0' }));
    act(() => apiRef.current.handleTopicEnter('Science', 'Science#0#0'));
    expect(apiRef.current.activeTopicKey).toBe('Science');
    expect(apiRef.current.activeTopicCardKey).toBe('Science#0#0');

    act(() => apiRef.current.handleTopicLeave('Science', 'Science#0#0'));
    expect(apiRef.current.activeTopicKey).toBe('Technology');
    expect(apiRef.current.activeTopicCardKey).toBe('Technology#0#0');
  });

  it('clears hover and selection together', () => {
    const { apiRef, cleanup } = setup();
    cleanups.push(cleanup);

    act(() => apiRef.current.toggleTopicSelection('Technology', { key: 'Technology#0#0' }));
    act(() => apiRef.current.handleTopicEnter('Science', 'Science#0#0'));
    act(() => apiRef.current.clearTopicSelection());

    expect(apiRef.current.activeTopicKey).toBeNull();
    expect(apiRef.current.activeTopicCardKey).toBeNull();
  });
});
