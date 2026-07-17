import { describe, expect, it } from 'vitest';
import { canStepUpElement, stepUpSelectedEntry } from './elementTraversal.js';

describe('elementTraversal', () => {
  it('detects when an element can step up to its parent', () => {
    const body = { nodeName: 'BODY' };
    const html = { nodeName: 'HTML' };
    const parent = { parentElement: body };
    const child = { parentElement: parent };

    expect(canStepUpElement(null, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(body, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(html, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(parent, { body, documentElement: html })).toBe(false);
    expect(canStepUpElement(child, { body, documentElement: html })).toBe(true);
  });

  it('steps up to the parent without duplicating an already selected parent', () => {
    const body = { nodeName: 'BODY' };
    const parent = { id: 'parent', parentElement: body };
    const child = { id: 'child', parentElement: parent };
    const sibling = { id: 'sibling', parentElement: body };

    const input = [
      { el: parent, originalNumber: 1 },
      { el: child, originalNumber: 2 },
      { el: sibling, originalNumber: 3 },
    ];

    const result = stepUpSelectedEntry(input, 1, {
      body,
      documentElement: { nodeName: 'HTML' },
    });

    expect(result.oldElement).toBe(child);
    expect(result.newElement).toBe(parent);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.el)).toEqual([parent, sibling]);
    expect(result.entries.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });

  it('steps up to the parent in place when the parent is not already selected', () => {
    const body = { nodeName: 'BODY' };
    const parent = { id: 'parent', parentElement: body };
    const child = { id: 'child', parentElement: parent };
    const sibling = { id: 'sibling', parentElement: body };

    const input = [
      { el: child, originalNumber: 1 },
      { el: sibling, originalNumber: 2 },
    ];

    const result = stepUpSelectedEntry(input, 0, {
      body,
      documentElement: { nodeName: 'HTML' },
    });

    expect(result.oldElement).toBe(child);
    expect(result.newElement).toBe(parent);
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].el).toBe(parent);
    expect(result.entries[1].el).toBe(sibling);
    expect(result.entries.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });
});
