// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { curlyBracePath, computeNoteColumn, layoutNotes } from './marginNotes.js';

describe('curlyBracePath', () => {
  it('points right at mid-height and hooks back to the left edge at both ends', () => {
    const d = curlyBracePath(14, 100);
    expect(d.startsWith('M1 1 ')).toBe(true);
    // The tip: the brace's right edge (width minus the stroke inset), halfway down.
    expect(d).toContain(' 13 50 ');
    expect(d.endsWith(' 1 99')).toBe(true);
  });

  it('keeps the spine segments from crossing on a short brace', () => {
    const d = curlyBracePath(14, 12);
    const lines = [...d.matchAll(/L7 ([\d.]+)/g)].map((match) => Number(match[1]));
    // First segment ends above the tip, second starts below it.
    expect(lines[0]).toBeLessThanOrEqual(6);
    expect(lines[1]).toBeGreaterThanOrEqual(6);
  });
});

describe('computeNoteColumn', () => {
  it('starts the brace just past the rightmost text edge', () => {
    const cards = [{ box: { right: 600 } }, { box: { right: 640 } }];
    expect(computeNoteColumn(cards, 1200)).toEqual({ left: 646, noteWidth: 288 });
  });

  it('narrows notes to the space left in the viewport, down to a readable minimum', () => {
    const cards = [{ box: { right: 900 } }];
    // 1100 - 906 - 14 - 4 - 12 = 164
    expect(computeNoteColumn(cards, 1100).noteWidth).toBe(164);
    expect(computeNoteColumn(cards, 950).noteWidth).toBe(144);
  });

  it('falls back to the right margin of the viewport when no text edge was measured', () => {
    expect(computeNoteColumn([{ box: {} }], 1000)).toEqual({ left: 682, noteWidth: 288 });
  });
});

describe('layoutNotes', () => {
  function buildTrack(labelHeights) {
    const track = document.createElement('div');
    for (const height of labelHeights) {
      const card = document.createElement('button');
      const label = document.createElement('span');
      label.className = 'pagetollm-note-label';
      Object.defineProperty(label, 'offsetHeight', { value: height });
      card.appendChild(label);
      track.appendChild(card);
    }
    return track;
  }
  const prop = (element, name) => element.style.getPropertyValue(name);

  it('centres each note on its brace tip', () => {
    const track = buildTrack([20]);
    layoutNotes(track, [{ box: { top: 100, height: 200 } }]);
    const [card] = track.children;
    expect(prop(card, '--pagetollm-note-y')).toBe('90px');
    expect(prop(card, '--pagetollm-note-h')).toBe('20px');
    expect(prop(card, '--pagetollm-note-y-min')).toBe('0px');
    expect(prop(card, '--pagetollm-note-y-max')).toBe('180px');
  });

  it('pushes a note down clear of the one above instead of overlapping it', () => {
    const track = buildTrack([40, 40]);
    layoutNotes(track, [{ box: { top: 0, height: 40 } }, { box: { top: 40, height: 40 } }]);
    const [first, second] = track.children;
    expect(prop(first, '--pagetollm-note-y')).toBe('0px');
    // Tip-centred it would start at 40, level with the first note's bottom;
    // the stack gap moves it 4px further.
    expect(prop(second, '--pagetollm-note-y')).toBe('4px');
    // The pushed position stays reachable for the sticky clamp.
    expect(prop(second, '--pagetollm-note-y-max')).toBe('4px');
  });
});
