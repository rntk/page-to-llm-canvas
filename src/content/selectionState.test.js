import { describe, expect, it } from 'vitest';
import {
  moveSelectedEntry,
  removeSelectedEntry,
  renumberSelectedEntries,
  selectedBlocksForToolbar,
} from './selectionState.js';

function entries(names) {
  return names.map((name, index) => ({ el: { name }, originalNumber: index + 10 }));
}

describe('selectionState', () => {
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
      { id: 1, originalNumber: 1 },
      { id: 2, originalNumber: 2 },
    ]);
  });
});
