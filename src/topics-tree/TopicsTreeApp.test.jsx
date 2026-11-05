// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import TopicsTreeApp from './TopicsTreeApp.jsx';
import { articleRootTitle } from './topicsTreeModel.js';
import { useRecord } from '../canvas/hooks/useRecord.js';

vi.mock('../canvas/hooks/useRecord.js', () => ({
  useRecord: vi.fn(),
}));

const doneRecord = {
  status: 'done',
  sourceUrl: 'https://news.example.com/story',
  sentences: ['One.', 'Two.', 'Three.', 'Four.'],
  topics: [
    { name: 'Fruit>Apples', sentences: [1, 2] },
    { name: 'Fruit>Pears', sentences: [3] },
    { name: 'Veg', sentences: [4] },
  ],
  topic_summary_index: {
    Fruit: { level: 0, runs: [{ text: 'Fruit overview.', sentences: [1, 2, 3] }] },
    'Fruit>Apples': { level: 1, runs: [{ text: 'Apples summary.', sentences: [1, 2] }] },
  },
};

function render(props) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(TopicsTreeApp, { initialKey: 'k1', ...props })));
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const titles = (container) =>
  [...container.querySelectorAll('.tt-node__title, .tt-card__title')].map((el) => el.textContent);

describe('articleRootTitle', () => {
  it('uses the source host, falling back to a generic label', () => {
    expect(articleRootTitle('https://news.example.com/a')).toBe('news.example.com');
    expect(articleRootTitle('')).toBe('Article');
  });
});

describe('TopicsTreeApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading, error, processing and empty states', () => {
    const cases = [
      [{ record: null, error: null }, 'Loading…'],
      [{ record: null, error: 'boom' }, 'Error: boom'],
      [{ record: { status: 'pending' }, error: null }, 'Still processing this page…'],
      [{ record: { status: 'error', error: 'Bad' }, error: null }, 'Processing Failed'],
      [
        { record: { status: 'needs_attention', summaryErrors: [{}] }, error: null },
        '1 topic needs attention',
      ],
      [{ record: { status: 'done', topics: [] }, error: null }, 'No topics were found'],
    ];
    for (const [value, text] of cases) {
      useRecord.mockReturnValue(value);
      const { container, unmount } = render();
      expect(container.textContent).toContain(text);
      unmount();
    }
  });

  it('closes when the record is deleted', () => {
    useRecord.mockReturnValue({ record: null, error: null, isDeleted: true });
    const onClose = vi.fn();
    const { container, unmount } = render({ onClose });
    expect(onClose).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
    unmount();
  });

  it('starts with the top-level topics and unfolds a topic on click', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const { container, unmount } = render();

    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Veg']);
    expect(container.textContent).toContain('Fruit overview.');

    const fruit = [...container.querySelectorAll('.tt-node')].find((el) =>
      el.textContent.startsWith('Fruit'),
    );
    act(() => fruit.click());
    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Apples', 'Pears', 'Veg']);
    expect(container.textContent).toContain('Apples summary.');
    expect(container.querySelectorAll('.tt-link')).toHaveLength(4);
    expect(container.querySelectorAll('.tt-link.is-on-path')).toHaveLength(1);

    act(() => fruit.click());
    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Veg']);
    unmount();
  });

  it('switches levels and expands everything from the toolbar', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const { container, unmount } = render();
    const button = (label) =>
      [...container.querySelectorAll('button')].find((el) => el.textContent === label);

    act(() => button('Expand all').click());
    expect(titles(container)).toHaveLength(5);
    expect(button('L1').className).toContain('active');

    act(() => button('L0').click());
    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Veg']);

    act(() => button('Expand all').click());
    act(() => button('Reset').click());
    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Veg']);
    unmount();
  });

  it('shows source sentences and jumps to them in the page', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const onNavigateToSentences = vi.fn();
    const { container, unmount } = render({ onNavigateToSentences });
    const veg = [...container.querySelectorAll('.tt-card')].find((el) =>
      el.textContent.startsWith('Veg'),
    );
    expect(veg.textContent).toContain('No summary for this topic.');

    const details = veg.querySelector('details');
    act(() => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    expect(veg.querySelector('.tt-passages').textContent).toBe('Four.');

    const show = [...veg.querySelectorAll('button')].find(
      (el) => el.textContent === 'Show in page',
    );
    act(() => show.click());
    expect(onNavigateToSentences).toHaveBeenCalledWith({
      key: 'k1',
      rail: 'page',
      sentenceNumbers: [4],
      level: 0,
      topicPath: 'Veg',
    });
    unmount();
  });

  it('closes on Escape and from the header button', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const onClose = vi.fn();
    const { container, unmount } = render({ onClose });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    act(() => container.querySelector('.th-page__close').click());
    expect(onClose).toHaveBeenCalledTimes(2);
    unmount();
  });
});
