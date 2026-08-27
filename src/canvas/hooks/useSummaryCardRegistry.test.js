// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createCardElementRegistry, useSummaryCardRegistry } from './useSummaryCardRegistry.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe('createCardElementRegistry', () => {
  it('registers, reads back, and lists elements', () => {
    const store = { current: {} };
    const registry = createCardElementRegistry(store);
    const first = { id: 'first' };
    const second = { id: 'second' };

    registry.register('a#0#0', first);
    registry.register('b#0#0', second);

    expect(registry.get('a#0#0')).toBe(first);
    expect(registry.entries()).toEqual([
      ['a#0#0', first],
      ['b#0#0', second],
    ]);
  });

  it('unregisters when React hands back a null ref on unmount', () => {
    const store = { current: {} };
    const registry = createCardElementRegistry(store);
    registry.register('a#0#0', { id: 'first' });

    registry.register('a#0#0', null);

    expect(registry.get('a#0#0')).toBeNull();
    expect(registry.entries()).toEqual([]);
  });

  it('returns null for unknown or missing keys rather than undefined', () => {
    const registry = createCardElementRegistry({ current: {} });

    expect(registry.get('nope')).toBeNull();
    expect(registry.get(null)).toBeNull();
    expect(registry.get(undefined)).toBeNull();
  });

  it('reads through to later writes on the same store', () => {
    const store = { current: {} };
    const registry = createCardElementRegistry(store);
    const el = { id: 'late' };

    expect(registry.get('late')).toBeNull();
    registry.register('late', el);

    expect(registry.get('late')).toBe(el);
  });
});

describe('useSummaryCardRegistry', () => {
  // Stable identity is the hook's whole contract: the registry is listed in the
  // dependency arrays of measureSummaryPositions (useSentenceMetrics) and
  // zoomToTopic (useCanvasTopicNavigation), so a fresh object per render would
  // churn both callbacks and thrash the rAF measurement pass.
  it('returns the same registry across renders', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const seen = [];

    function Harness() {
      seen.push(useSummaryCardRegistry());
      return null;
    }

    act(() => root.render(createElement(Harness)));
    act(() => root.render(createElement(Harness, { rerender: true })));

    expect(seen.length).toBeGreaterThan(1);
    seen.forEach((registry) => expect(registry).toBe(seen[0]));

    // The registry still reads and writes after re-rendering.
    const el = { id: 'el' };
    seen[0].register('a#0#0', el);
    expect(seen[0].get('a#0#0')).toBe(el);

    act(() => root.unmount());
    container.remove();
  });
});
