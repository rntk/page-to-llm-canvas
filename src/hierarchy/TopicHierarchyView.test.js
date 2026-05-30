// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import TopicHierarchyView from './TopicHierarchyView.jsx';

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

describe('TopicHierarchyView', () => {
  it('renders empty state when topics is empty', () => {
    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: [],
        topicSummaries: {},
        topicSummaryIndex: {},
        selectedTopicPath: null,
        onTopicClick: vi.fn(),
      }),
    );

    const empty = container.querySelector('.th-empty');
    expect(empty).not.toBeNull();
    expect(empty.textContent).toContain('No topics available');
    unmount();
  });

  it('renders tree nodes and leaf rows with correct styling, summaries, and handles clicks', () => {
    const onTopicClick = vi.fn();
    const mockTopics = [
      {
        name: 'Fruit > Apple',
        sentences: [1, 2, 3],
        summary: 'An apple a day',
      },
      {
        name: 'Fruit > Banana',
        sentences: [4, 5],
      },
      {
        name: 'Veggie',
        sentences: [10],
        summary_text: 'Healthy veggie',
      },
    ];

    const mockSummaries = {
      'Fruit>Banana': {
        text: 'Yellow fruit summary',
      },
    };

    const { container, unmount } = render(
      createElement(TopicHierarchyView, {
        topics: mockTopics,
        topicSummaries: mockSummaries,
        topicSummaryIndex: {},
        selectedTopicPath: 'Fruit>Apple',
        onTopicClick,
      }),
    );

    // root th-root element
    const thRoot = container.querySelector('.th-root');
    expect(thRoot).not.toBeNull();

    // Check veggie (root and leaf)
    const veggieLeaf = container.querySelectorAll('.th-leaf-row')[2];
    expect(veggieLeaf).not.toBeUndefined();
    expect(veggieLeaf.textContent).toContain('Veggie');
    expect(veggieLeaf.textContent).toContain('Healthy veggie');

    // Click on Veggie leaf
    const veggieBtn = veggieLeaf.querySelector('.th-leaf');
    act(() => veggieBtn.click());
    expect(onTopicClick).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ name: 'Veggie' }),
      }),
    );

    // Check Fruit node
    const fruitNode = container.querySelector('.th-node');
    expect(fruitNode).not.toBeNull();
    const fruitLabel = fruitNode.querySelector('.th-node__label');
    expect(fruitLabel.textContent).toContain('Fruit');

    // Click Fruit node
    onTopicClick.mockClear();
    act(() => fruitLabel.click());
    expect(onTopicClick).toHaveBeenCalledWith(
      expect.objectContaining({
        node: expect.objectContaining({ name: 'Fruit' }),
      }),
    );

    // Apple leaf check - selectedTopicPath is "Fruit>Apple" (which matches)
    const appleLeaf = container.querySelectorAll('.th-leaf-row')[0];
    const appleBtn = appleLeaf.querySelector('.th-leaf');
    expect(appleBtn.className).toContain('is-selected');

    // Banana leaf check - summary is looked up
    const bananaLeaf = container.querySelectorAll('.th-leaf-row')[1];
    expect(bananaLeaf.textContent).toContain('Banana');
    expect(bananaLeaf.textContent).toContain('Yellow fruit summary');

    unmount();
  });
});
