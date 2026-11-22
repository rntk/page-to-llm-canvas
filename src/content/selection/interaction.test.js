// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { createSelectionInteraction } from './interaction.js';
import { createSelectedEntry } from './state.js';
import { isElementSelected } from './markers.js';

const userEvent = () => ({ preventDefault() {}, stopPropagation() {} });

function setup() {
  document.body.innerHTML = '<p id="a">A</p><p id="b">B</p><p id="c">C</p>';
  const [a, b, c] = ['a', 'b', 'c'].map((id) => document.getElementById(id));
  const interaction = createSelectionInteraction({
    document,
    guardTrustedUserEvent: () => true,
    onChange: () => {},
  });
  const pick = (el) => {
    interaction.toggleSelectionMode(userEvent());
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  };
  const view = (selected) => selected.map(({ el, originalNumber }) => [el.id, originalNumber]);
  return { a, b, c, interaction, pick, view };
}

describe('selection interaction value semantics', () => {
  let current;
  afterEach(() => {
    current?.interaction.destroy();
    document.body.innerHTML = '';
  });

  it('keeps earlier snapshots stable across append, reorder, and removal', () => {
    current = setup();
    const { a, b, c, interaction, pick, view } = current;

    pick(a);
    pick(b);
    const afterTwo = interaction.snapshot().selectedElements;
    pick(c);
    const afterThree = interaction.snapshot().selectedElements;
    expect(afterTwo).toHaveLength(2);

    interaction.onDragStart(userEvent(), 0);
    interaction.onDrop(userEvent(), 2);
    const afterMove = interaction.snapshot().selectedElements;
    expect(view(afterMove)).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 3],
    ]);

    interaction.removeBlock(userEvent(), 0);
    expect(view(interaction.snapshot().selectedElements)).toEqual([
      ['c', 1],
      ['a', 2],
    ]);

    expect(view(afterTwo)).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(view(afterThree)).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    expect(view(afterMove)).toEqual([
      ['b', 1],
      ['c', 2],
      ['a', 3],
    ]);
    expect(afterMove[2].el).toBe(a);
    expect(isElementSelected(b)).toBe(false);
    expect(isElementSelected(a)).toBe(true);
    expect(isElementSelected(c)).toBe(true);
  });

  it('does not let snapshot or Find callers edit interaction state', () => {
    current = setup();
    const { a, b, interaction, view } = current;

    const found = [createSelectedEntry(a, 1), createSelectedEntry(b, 2)];
    interaction.startFind();
    interaction.finishFind(found, 'Found 2 text blocks');
    found.pop();
    interaction.snapshot().selectedElements.length = 0;

    expect(view(interaction.snapshot().selectedElements)).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(isElementSelected(a) && isElementSelected(b)).toBe(true);

    const kept = interaction.snapshot().selectedElements;
    interaction.removeBlock(userEvent(), 0);
    expect(view(kept)).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(view(interaction.snapshot().selectedElements)).toEqual([['b', 1]]);
  });

  it('does not let callers redirect a live entry through snapshot or Find records', () => {
    current = setup();
    const { a, b, c, interaction, view } = current;

    const found = [createSelectedEntry(a, 1), createSelectedEntry(b, 2)];
    interaction.startFind();
    interaction.finishFind(found, 'Found 2 text blocks');
    found[0].el = c;
    found[1].originalNumber = 99;

    const live = interaction.snapshot().selectedElements;
    expect(() => {
      live[0].el = c;
    }).toThrow(TypeError);
    expect(live[0].el).toBe(a);
    expect(view(interaction.snapshot().selectedElements)).toEqual([
      ['a', 1],
      ['b', 2],
    ]);

    interaction.removeBlock(userEvent(), 0);
    expect(isElementSelected(a)).toBe(false);
    expect(isElementSelected(c)).toBe(false);
    expect(isElementSelected(b)).toBe(true);
  });
});
