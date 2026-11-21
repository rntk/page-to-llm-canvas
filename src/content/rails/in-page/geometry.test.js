// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getScrollTop,
  getRailOriginTop,
  getScrollableAncestor,
  computeCardVerticalBox,
} from './geometry.js';

describe('in-page rail geometry helpers', () => {
  it('getScrollTop uses scrollTop for non-window containers', () => {
    const el = { scrollTop: 123 };
    expect(getScrollTop(el, window)).toBe(123);
  });

  it('getScrollTop falls back to window.scrollY for window container', () => {
    const orig = window.scrollY;
    // @ts-ignore
    window.scrollY = 77;
    expect(getScrollTop(window, window)).toBe(77);
    // @ts-ignore
    window.scrollY = orig;
  });

  it('getRailOriginTop is the rail body viewport top, whatever the scroller', () => {
    const orig = window.scrollY;
    // @ts-ignore
    window.scrollY = 30;
    expect(getRailOriginTop({ top: 10 })).toBe(10);
    // @ts-ignore
    window.scrollY = orig;
  });
});

describe('getScrollableAncestor', () => {
  let container;
  let makeEl;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    makeEl = (tag = 'div', styles = {}) => {
      const el = document.createElement(tag);
      Object.assign(el.style, styles);
      // Minimal layout so scrollHeight/clientHeight can be influenced
      Object.defineProperty(el, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
      return el;
    };
  });

  afterEach(() => {
    container.remove();
  });

  it('returns window when no picked elements', () => {
    expect(getScrollableAncestor([])).toBe(window);
  });

  it('returns the injected window for an empty or non-scrollable selection', () => {
    const injectedWindow = {
      document: { body: document.body, documentElement: document.documentElement },
      getComputedStyle: () => ({ overflowY: 'visible', overflow: 'visible' }),
    };
    expect(getScrollableAncestor([], { win: injectedWindow })).toBe(injectedWindow);

    const picked = makeEl('span');
    container.appendChild(picked);
    expect(getScrollableAncestor([picked], { win: injectedWindow })).toBe(injectedWindow);
  });

  it('returns the first scrollable ancestor that contains all picked elements', () => {
    const outer = makeEl('div', { overflow: 'auto' });
    const inner = makeEl('div');
    const picked = makeEl('span');
    inner.appendChild(picked);
    outer.appendChild(inner);
    container.appendChild(outer);

    // Make outer look scrollable via the injected getComputedStyle
    const gcs = (el) => {
      if (el === outer) return { overflowY: 'auto', overflow: '' };
      return { overflowY: '', overflow: '' };
    };

    const ancestor = getScrollableAncestor([picked], {
      getComputedStyle: gcs,
      body: document.body,
      docEl: document.documentElement,
    });
    expect(ancestor).toBe(outer);
  });

  it('falls back to window if nothing is scrollable', () => {
    const parent = makeEl('div');
    const picked = makeEl('span');
    parent.appendChild(picked);
    container.appendChild(parent);

    const gcs = () => ({ overflowY: 'visible', overflow: 'visible' });
    const ancestor = getScrollableAncestor([picked], {
      getComputedStyle: gcs,
      body: document.body,
      docEl: document.documentElement,
    });
    expect(ancestor).toBe(window);
  });

  it('exercises the default (un-injected) getComputedStyle path using real window.getComputedStyle', () => {
    const outer = makeEl('div');
    outer.style.overflow = 'auto'; // real getComputedStyle will report this
    const inner = makeEl('div');
    const picked = makeEl('span');
    inner.appendChild(picked);
    outer.appendChild(inner);
    container.appendChild(outer);

    // No injected getComputedStyle: exercises the default receiver-binding wrapper.
    const ancestor = getScrollableAncestor([picked]);
    expect(ancestor).toBe(outer);
  });
});

describe('computeCardVerticalBox', () => {
  it('returns null for empty sentences', () => {
    expect(computeCardVerticalBox([], new Map(), [], 0, window)).toBeNull();
  });

  it('computes box from provided buildRange results using getClientRects', () => {
    // Fake sentence ranges + word entries
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 0 }]]);
    const wordEntries = [{}]; // values ignored because we override buildRange

    // Build a fake range whose rects give us known tops/bottoms
    const fakeRange = {
      getClientRects: () => [
        { top: 10, bottom: 20, width: 100, height: 10 },
        { top: 22, bottom: 30, width: 100, height: 8 },
      ],
    };
    const buildRange = () => fakeRange;

    // scrollContainer = window, scrollY=0, railOriginTop=5
    const origSY = window.scrollY;
    // @ts-ignore
    window.scrollY = 0;

    const box = computeCardVerticalBox([1], sentenceRanges, wordEntries, 5, window, { buildRange });

    // The 20px measured span is clamped to the 40px minimum height.
    expect(box.top).toBe(5);
    expect(box.height).toBe(40);

    // @ts-ignore
    window.scrollY = origSY;
  });

  it('skips rects that are not laid out (zero size)', () => {
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 0 }]]);
    const wordEntries = [{}];
    const fakeRange = {
      getClientRects: () => [
        { top: 0, bottom: 0, width: 0, height: 0 },
        { top: 100, bottom: 140, width: 10, height: 40 },
      ],
    };
    const buildRange = () => fakeRange;

    const box = computeCardVerticalBox([1], sentenceRanges, wordEntries, 0, window, { buildRange });
    expect(box).not.toBeNull();
    expect(box.top).toBe(100);
    expect(box.height).toBe(40);
  });

  it('returns null when no laid out rects produce finite bounds', () => {
    const sentenceRanges = new Map([[1, { startIdx: 0, endIdx: 0 }]]);
    const wordEntries = [{}];
    const fakeRange = {
      getClientRects: () => [{ top: Infinity, bottom: -Infinity, width: 0, height: 0 }],
    };
    const buildRange = () => fakeRange;
    expect(
      computeCardVerticalBox([1], sentenceRanges, wordEntries, 0, window, { buildRange }),
    ).toBeNull();
  });

  it('aggregates bounds across multiple sentences, applies scroll offset, and tracks horizontal edges', () => {
    const ranges = new Map([
      [1, null],
      [
        2,
        {
          getClientRects: () => [
            { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
            { top: 20, bottom: 45, left: 100, right: 250, width: 150, height: 25 },
          ],
        },
      ],
      [
        3,
        {
          getClientRects: () => [
            { top: 50, bottom: 90, left: 80, right: 300, width: 220, height: 40 },
          ],
        },
      ],
    ]);
    const buildRange = (_sr, _we, sNum) => ranges.get(sNum) ?? null;
    const box = computeCardVerticalBox(
      [1, 2, 3],
      new Map(),
      [],
      10,
      { scrollTop: 50 },
      {
        buildRange,
      },
    );
    expect(box).toEqual({ top: 60, height: 70, left: 80, right: 300 });
  });

  it('clamps negative top to 0 and computes height from clampedTop', () => {
    const fakeRange = {
      getClientRects: () => [
        { top: -10, bottom: 60, left: 40, right: 200, width: 160, height: 70 },
      ],
    };
    const box = computeCardVerticalBox(
      [1],
      new Map(),
      [],
      10,
      { scrollTop: 0 },
      {
        buildRange: () => fakeRange,
      },
    );
    expect(box).toEqual({ top: 0, height: 50, left: 40, right: 200 });
  });

  it('returns null when railOriginTop produces non-finite bounds', () => {
    const fakeRange = {
      getClientRects: () => [{ top: 10, bottom: 30, left: 20, right: 100, width: 80, height: 20 }],
    };
    expect(
      computeCardVerticalBox(
        [1],
        new Map(),
        [],
        NaN,
        { scrollTop: 0 },
        {
          buildRange: () => fakeRange,
        },
      ),
    ).toBeNull();
  });
});
