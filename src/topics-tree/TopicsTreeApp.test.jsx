// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    // Reduced motion: folded nodes disappear at once instead of lingering to animate out.
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('folds a reused summary in the primary Business > Risk branch', () => {
    const summary = 'OpenAI and Anthropic plan gigawatt-scale chip data centers.';
    useRecord.mockReturnValue({
      record: {
        ...doneRecord,
        topics: [{ name: 'Business>Risk>Balance Sheet Business', sentences: [1] }],
        topic_summary_index: {
          Business: { runs: [{ text: 'Business overview.' }] },
          'Business>Risk': { runs: [{ text: summary }] },
          'Business>Risk>Balance Sheet Business': { runs: [{ text: summary }] },
        },
      },
      error: null,
    });
    const { container, unmount } = render();
    const topic = (title) =>
      [...container.querySelectorAll('.tt-node')].find(
        (el) => el.querySelector('.tt-node__title').textContent === title,
      );
    act(() => topic('Business').click());
    act(() => topic('Risk').click());
    const duplicate = topic('Balance Sheet Business');
    expect(topic('Risk').querySelector('.tt-node__prose').hidden).toBe(false);
    expect(duplicate.querySelector('.tt-node__prose').hidden).toBe(true);
    act(() => duplicate.querySelector('.tt-node__summary-toggle button').click());
    expect(duplicate.querySelector('.tt-node__prose').hidden).toBe(false);
    expect(duplicate.getAttribute('aria-expanded')).toBe('false');
    unmount();
  });

  it('keeps folded nodes as inert ghosts until the fold animation is over', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    try {
      useRecord.mockReturnValue({ record: doneRecord, error: null });
      const { container, unmount } = render();
      const fruit = [...container.querySelectorAll('.tt-node')].find((el) =>
        el.textContent.startsWith('Fruit'),
      );
      act(() => fruit.click());
      act(() => fruit.click());

      const ghosts = container.querySelectorAll('.tt-leaving');
      expect(ghosts).toHaveLength(2);
      expect(container.querySelector('.tt-canvas').dataset.motion).toBe('on');
      expect(container.querySelectorAll('.tt-link.is-leaving')).toHaveLength(2);

      act(() => vi.advanceTimersByTime(1000));
      expect(container.querySelectorAll('.tt-leaving')).toHaveLength(0);
      expect(container.querySelector('.tt-canvas').dataset.motion).toBeUndefined();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches levels from the controls in the page bar', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const { container, unmount } = render();
    const button = (label) =>
      [...container.querySelectorAll('button')].find((el) => el.textContent === label);

    expect(container.querySelector('.th-page__bar .tt-controls')).not.toBeNull();
    expect(button('Expand all')).toBeUndefined();
    expect(button('Tidy')).toBeUndefined();
    expect(button('Reset')).toBeUndefined();

    act(() => button('L1').click());
    expect(titles(container)).toHaveLength(6);
    expect(button('L1').className).toContain('active');

    act(() => button('L0').click());
    expect(titles(container)).toEqual(['news.example.com', 'Fruit', 'Veg']);
    unmount();
  });

  it('shows source sentences and jumps to them in the page', () => {
    useRecord.mockReturnValue({ record: doneRecord, error: null });
    const onNavigateToSentences = vi.fn();
    const { container, unmount } = render({ onNavigateToSentences });
    const vegNode = [...container.querySelectorAll('.tt-node')].find((el) =>
      el.textContent.startsWith('Veg'),
    );
    act(() => vegNode.click());
    const veg = container.querySelector('.tt-card');
    expect(veg.querySelector('.tt-card__title').textContent).toBe('Source');
    expect(veg.querySelector('.tt-card__head .tt-muted').textContent).toBe('Veg');
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

  it('switches to the summary tree and starts, stops, and resumes its build', async () => {
    const recordSource = {
      buildSummaryTree: vi.fn().mockResolvedValue({ ok: true }),
      stopSummaryTree: vi.fn().mockResolvedValue({ ok: true }),
    };
    const sourceButton = (container, label) =>
      [...container.querySelectorAll('.tt-source-switcher button')].find(
        (button) => button.textContent === label,
      );
    const actionButton = (container, label) =>
      [...container.querySelectorAll('.th-page__bar .tt-source-status button')].find(
        (button) => button.textContent === label,
      );

    useRecord.mockReturnValue({ record: { ...doneRecord, contentRevision: 'r1' }, error: null });
    let view = render({ recordSource });
    act(() => sourceButton(view.container, 'Summary tree').click());
    expect(view.container.textContent).toContain('Not built yet');
    expect(titles(view.container)).toEqual([]);
    await act(async () => actionButton(view.container, 'Build summary tree').click());
    expect(recordSource.buildSummaryTree).toHaveBeenCalledWith('k1', { fresh: false });
    view.unmount();

    const nodes = {
      n0: {
        id: 'n0',
        kind: 'passage',
        title: 'Crisp',
        children: [],
        sentences: [1, 2],
        segments: [{ text: 'Apples are crisp.', sources: [{ kind: 'rows', first: 1, last: 1 }] }],
      },
      n1: {
        id: 'n1',
        kind: 'root',
        title: 'x',
        children: ['n0'],
        sentences: [1, 2],
        segments: [
          { text: 'An apple story.', sources: [{ kind: 'claim', child: 'n0', segment: 0 }] },
        ],
      },
    };
    const tree = (status) => ({
      version: 1,
      status,
      stage: 'summaries',
      contentRevision: 'r1',
      rootId: 'n1',
      nodes,
      progress: { done: 0, total: 1 },
      updatedAt: Date.now(),
      error: status === 'error' ? 'Model down' : null,
      metrics: { passages: 1, topics: 0 },
    });

    useRecord.mockReturnValue({
      record: { ...doneRecord, contentRevision: 'r1', summary_tree: tree('running') },
      error: null,
    });
    view = render({ recordSource });
    act(() => sourceButton(view.container, 'Summary tree').click());
    expect(view.container.textContent).toContain('Summarizing topics 0/1…');
    await act(async () => actionButton(view.container, 'Stop').click());
    expect(recordSource.stopSummaryTree).toHaveBeenCalledWith('k1');
    view.unmount();

    useRecord.mockReturnValue({
      record: { ...doneRecord, contentRevision: 'r1', summary_tree: tree('error') },
      error: null,
    });
    view = render({ recordSource });
    act(() => sourceButton(view.container, 'Summary tree').click());
    expect(view.container.textContent).toContain('The build failed: Model down');
    expect(titles(view.container)).toEqual(['news.example.com', 'Crisp']);
    expect(view.container.textContent).toContain('An apple story.');
    await act(async () => actionButton(view.container, 'Rebuild').click());
    expect(recordSource.buildSummaryTree).toHaveBeenLastCalledWith('k1', { fresh: true });
    act(() => sourceButton(view.container, 'Pipeline').click());
    expect(titles(view.container)).toContain('Fruit');
    view.unmount();
  });
});
