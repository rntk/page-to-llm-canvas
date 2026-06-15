// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getScrollTop,
  getRailOriginTop,
  getScrollableAncestor,
  computeCardVerticalBox,
} from './railGeometry.js';

describe('railGeometry scroll helpers', () => {
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

  it('getRailOriginTop adjusts by scrollY only for window', () => {
    const rect = { top: 10 };
    const el = { scrollTop: 5 };
    expect(getRailOriginTop(rect, el, window)).toBe(10);

    const orig = window.scrollY;
    // @ts-ignore
    window.scrollY = 30;
    expect(getRailOriginTop(rect, window, window)).toBe(40);
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
      // Provide minimal layout so scrollHeight/clientHeight checks can be influenced
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

    const ancestor = getScrollableAncestor([picked], { getComputedStyle: gcs, body: document.body, docEl: document.documentElement });
    expect(ancestor).toBe(outer);
  });

  it('falls back to window if nothing is scrollable', () => {
    const parent = makeEl('div');
    const picked = makeEl('span');
    parent.appendChild(picked);
    container.appendChild(parent);

    const gcs = () => ({ overflowY: 'visible', overflow: 'visible' });
    const ancestor = getScrollableAncestor([picked], { getComputedStyle: gcs, body: document.body, docEl: document.documentElement });
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

    // Intentionally do NOT inject getComputedStyle — exercises the default wrapper
    // (which binds the receiver correctly). This path is taken in production from main.jsx.
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

    // tops after scroll-rail adjust: min(10,22) +0 -5 = 5; bottoms max 20,30 +0-5=25; clamped height max(40,20)
    // Wait: height = 25-5=20 but min 40? No: Math.max(40, bottom-clampedTop) => max(40,20)=40
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
    expect(computeCardVerticalBox([1], sentenceRanges, wordEntries, 0, window, { buildRange })).toBeNull();
  });
});
