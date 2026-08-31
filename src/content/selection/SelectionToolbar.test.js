// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import SelectionToolbar from './SelectionToolbar.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('SelectionToolbar', () => {
  const defaultProps = {
    isPicking: false,
    selectedBlocks: [],
    draggingIndex: null,
    dragOverIndex: null,
    onTogglePicking: vi.fn(),
    onSubmit: vi.fn(),
    onCancel: vi.fn(),
    onRemoveBlock: vi.fn(),
    onStepUpBlock: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDrop: vi.fn(),
    onDragEnd: vi.fn(),
  };

  it('renders correctly with empty blocks', () => {
    const { container, unmount } = render(createElement(SelectionToolbar, defaultProps));

    const pickBtn = container.querySelector('#pagetollm-pick-btn');
    const submitBtn = container.querySelector('#pagetollm-submit-btn');

    expect(pickBtn.textContent).toBe('Pick Block');
    expect(pickBtn.className).not.toContain('active');
    expect(submitBtn.textContent).toBe('Submit');
    expect(submitBtn.disabled).toBe(true);

    unmount();
  });

  it('renders correctly with picking state and selected blocks', () => {
    const onTogglePicking = vi.fn();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const onRemoveBlock = vi.fn();

    const { container, unmount } = render(
      createElement(SelectionToolbar, {
        ...defaultProps,
        isPicking: true,
        selectedBlocks: [
          { id: 'b1', originalNumber: 1 },
          { id: 'b2', originalNumber: 2 },
        ],
        onTogglePicking,
        onSubmit,
        onCancel,
        onRemoveBlock,
      }),
    );

    const pickBtn = container.querySelector('#pagetollm-pick-btn');
    const submitBtn = container.querySelector('#pagetollm-submit-btn');
    const cancelBtn = container.querySelector('#pagetollm-cancel-btn');

    expect(pickBtn.textContent).toBe('Picking...');
    expect(pickBtn.className).toContain('active');
    expect(submitBtn.textContent).toBe('Submit (2)');
    expect(submitBtn.disabled).toBe(false);

    // Test button clicks
    act(() => pickBtn.click());
    expect(onTogglePicking).toHaveBeenCalled();

    act(() => submitBtn.click());
    expect(onSubmit).toHaveBeenCalled();

    act(() => cancelBtn.click());
    expect(onCancel).toHaveBeenCalled();

    // Test list items
    const listItems = container.querySelectorAll('.pagetollm-block-item');
    expect(listItems).toHaveLength(2);
    expect(listItems[0].textContent).toContain('Block 1');
    expect(listItems[1].textContent).toContain('Block 2');

    // Remove button click
    const removeBtn = listItems[0].querySelector('.pagetollm-remove-btn');
    act(() => removeBtn.click());
    expect(onRemoveBlock).toHaveBeenCalledWith(expect.any(Object), 0);

    unmount();
  });

  it('shows submission progress and disables toolbar actions while submitting', () => {
    const { container, unmount } = render(
      createElement(SelectionToolbar, {
        ...defaultProps,
        isSubmitting: true,
        selectedBlocks: [{ id: 'b1', originalNumber: 1, canStepUp: true }],
      }),
    );

    expect(container.querySelector('#pagetollm-submit-btn').textContent).toBe('Submitting...');
    expect(container.querySelector('#pagetollm-submit-btn').disabled).toBe(true);
    expect(container.querySelector('#pagetollm-submit-btn').className).toContain('submitting');
    expect(container.querySelector('#pagetollm-pick-btn').disabled).toBe(true);
    expect(container.querySelector('#pagetollm-cancel-btn').disabled).toBe(true);
    expect(container.querySelector('.pagetollm-remove-btn').disabled).toBe(true);
    expect(container.querySelector('.pagetollm-stepup-btn').disabled).toBe(true);
    expect(container.querySelector('#pagetollm-toolbar-top').getAttribute('aria-busy')).toBe(
      'true',
    );
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();

    unmount();
  });

  it('renders the step-up button and triggers onStepUpBlock', () => {
    const onStepUpBlock = vi.fn();

    const { container, unmount } = render(
      createElement(SelectionToolbar, {
        ...defaultProps,
        selectedBlocks: [
          { id: 'b1', originalNumber: 1, canStepUp: true },
          { id: 'b2', originalNumber: 2, canStepUp: false },
        ],
        onStepUpBlock,
      }),
    );

    const listItems = container.querySelectorAll('.pagetollm-block-item');
    const stepUpButtons = container.querySelectorAll('.pagetollm-stepup-btn');
    expect(stepUpButtons).toHaveLength(2);
    expect(stepUpButtons[0].disabled).toBe(false);
    expect(stepUpButtons[1].disabled).toBe(true);

    act(() => stepUpButtons[0].click());
    expect(onStepUpBlock).toHaveBeenCalledWith(expect.any(Object), 0);

    // Disabled button on a non-steppable block does not fire.
    act(() => listItems[1].querySelector('.pagetollm-stepup-btn').click());
    expect(onStepUpBlock).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('renders drag/drop classes and triggers events', () => {
    const onDragStart = vi.fn();
    const onDragOver = vi.fn();
    const onDrop = vi.fn();
    const onDragEnd = vi.fn();

    const { container, unmount } = render(
      createElement(SelectionToolbar, {
        ...defaultProps,
        selectedBlocks: [
          { id: 'b1', originalNumber: 1 },
          { id: 'b2', originalNumber: 2 },
        ],
        draggingIndex: 0,
        dragOverIndex: 1,
        onDragStart,
        onDragOver,
        onDrop,
        onDragEnd,
      }),
    );

    const listItems = container.querySelectorAll('.pagetollm-block-item');
    expect(listItems[0].className).toContain('pagetollm-dragging');
    expect(listItems[1].className).toContain('pagetollm-drag-over');

    // Simulate drag start on first item
    const dragStartEvent = new CustomEvent('dragstart', { bubbles: true });
    act(() => {
      listItems[0].dispatchEvent(dragStartEvent);
    });
    expect(onDragStart).toHaveBeenCalledWith(expect.any(Object), 0);

    // Simulate drag over on second item
    const dragOverEvent = new CustomEvent('dragover', { bubbles: true });
    act(() => {
      listItems[1].dispatchEvent(dragOverEvent);
    });
    expect(onDragOver).toHaveBeenCalledWith(expect.any(Object), 1);

    // Simulate drop on second item
    const dropEvent = new CustomEvent('drop', { bubbles: true });
    act(() => {
      listItems[1].dispatchEvent(dropEvent);
    });
    expect(onDrop).toHaveBeenCalledWith(expect.any(Object), 1);

    // Simulate drag end on first item
    const dragEndEvent = new CustomEvent('dragend', { bubbles: true });
    act(() => {
      listItems[0].dispatchEvent(dragEndEvent);
    });
    expect(onDragEnd).toHaveBeenCalled();

    unmount();
  });
});
