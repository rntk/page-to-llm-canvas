// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import TopicLevelSwitcher from './TopicLevelSwitcher.jsx';

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
    rerender(newElement) {
      act(() => root.render(newElement));
    },
  };
}

describe('TopicLevelSwitcher', () => {
  it('renders buttons for levels up to maxLevel', () => {
    const onChange = vi.fn();
    const { container, unmount } = render(
      createElement(TopicLevelSwitcher, {
        selectedLevel: 1,
        maxLevel: 2,
        onChange,
      }),
    );

    const buttons = container.querySelectorAll('.topic-level-switcher__button');
    expect(buttons).toHaveLength(3); // L0, L1, L2
    expect(buttons[0].textContent).toBe('L0');
    expect(buttons[1].textContent).toBe('L1');
    expect(buttons[2].textContent).toBe('L2');

    expect(buttons[1].className).toContain('active');
    expect(buttons[0].className).not.toContain('active');

    act(() => {
      buttons[2].click();
    });
    expect(onChange).toHaveBeenCalledWith(2);

    unmount();
  });

  it('renders with custom label and custom option labels', () => {
    const { container, unmount } = render(
      createElement(TopicLevelSwitcher, {
        selectedLevel: 0,
        maxLevel: 1,
        onChange: () => {},
        label: 'Custom Label:',
        getOptionLabel: (level) => `Level ${level}`,
      }),
    );

    const label = container.querySelector('.topic-level-switcher__label');
    expect(label.textContent).toBe('Custom Label:');

    const buttons = container.querySelectorAll('.topic-level-switcher__button');
    expect(buttons[0].textContent).toBe('Level 0');
    expect(buttons[1].textContent).toBe('Level 1');

    unmount();
  });

  it('renders without label if label is empty', () => {
    const { container, unmount } = render(
      createElement(TopicLevelSwitcher, {
        selectedLevel: 0,
        maxLevel: 1,
        onChange: () => {},
        label: '',
      }),
    );

    const label = container.querySelector('.topic-level-switcher__label');
    expect(label).toBeNull();

    unmount();
  });
});
