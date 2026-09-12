import { describe, expect, it } from 'vitest';
import {
  canStepUpElement,
  moveSelectedEntry,
  removeSelectedEntry,
  renumberSelectedEntries,
  selectedBlocksForToolbar,
  stepUpSelectedEntry,
} from './state.js';

function entries(names) {
  return names.map((name, index) => ({ el: { name }, originalNumber: index + 10 }));
}

describe('selection state', () => {
  it('renumbers entries without changing their element references', () => {
    const input = entries(['a', 'b']);
    const result = renumberSelectedEntries(input);
    expect(result).toBe(input);
    expect(result[0]).toBe(input[0]);
    expect(result[1]).toBe(input[1]);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2]);
    expect(result.map((entry) => entry.el)).toEqual(input.map((entry) => entry.el));
  });

  it('removes an entry and closes numbering gaps', () => {
    const result = removeSelectedEntry(entries(['a', 'b', 'c']), 1);
    expect(result.map((entry) => entry.el.name)).toEqual(['a', 'c']);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2]);
  });

  it('moves an entry and renumbers the resulting order', () => {
    const input = entries(['a', 'b', 'c']);
    const movedEntry = input[0];
    const result = moveSelectedEntry(input, 0, 2);
    expect(result.map((entry) => entry.el.name)).toEqual(['b', 'c', 'a']);
    expect(result[2]).toBe(movedEntry);
    expect(result.map((entry) => entry.originalNumber)).toEqual([1, 2, 3]);
  });

  it('normalizes numbering for invalid moves and removals', () => {
    expect(
      moveSelectedEntry(entries(['a', 'b']), 0, 0).map((entry) => entry.originalNumber),
    ).toEqual([1, 2]);
    expect(
      removeSelectedEntry(entries(['a', 'b']), 5).map((entry) => entry.originalNumber),
    ).toEqual([1, 2]);
  });

  it('builds the toolbar view model from selected entries', () => {
    expect(selectedBlocksForToolbar(renumberSelectedEntries(entries(['a', 'b'])))).toEqual([
      { id: 1, originalNumber: 1, canStepUp: true },
      { id: 2, originalNumber: 2, canStepUp: true },
    ]);
  });

  it('derives canStepUp per entry from the provided predicate', () => {
    const input = renumberSelectedEntries(entries(['a', 'b']));
    const result = selectedBlocksForToolbar(input, (el) => el.name !== 'b');
    expect(result.map((block) => block.canStepUp)).toEqual([true, false]);
  });
});

describe('element traversal', () => {
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
