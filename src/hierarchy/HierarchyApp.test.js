// @vitest-environment happy-dom
import { completeResplitDialog } from '../../test/resplitDialog.mjs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloneElement, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import HierarchyApp from './HierarchyApp.jsx';
import { useRecord } from '../canvas/hooks/useRecord.js';
import { TOPIC_TAG_CLOUD_VERSION } from '../shared/runtime/topicTagClouds.js';

vi.mock('../canvas/hooks/useRecord.js', () => ({
  useRecord: vi.fn(),
}));

const hostActions = {
  onClose: vi.fn(),
  onNavigateToSentences: vi.fn(),
};

function render(element, hostOverrides = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      cloneElement(element, {
        ...hostActions,
        ...element.props,
        ...hostOverrides,
      }),
    ),
  );
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

describe('HierarchyApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('parent', {
      postMessage: vi.fn(),
    });
    Object.defineProperty(window.location, 'ancestorOrigins', {
      value: ['https://host.example'],
      configurable: true,
    });
  });

  it('renders loading state when record is null and no error', () => {
    useRecord.mockReturnValue({ record: null, error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Loading…');
    unmount();
  });

  it('uses safe no-op host actions when none are injected', () => {
    useRecord.mockReturnValue({
      record: { status: 'done', topics: [{ name: 'Fruit', sentences: [1] }] },
      error: null,
    });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }), {
      onClose: undefined,
      onNavigateToSentences: undefined,
    });

    expect(() =>
      act(() => {
        container.querySelector('.th-leaf').click();
        container.querySelector('.th-page__close').click();
      }),
    ).not.toThrow();
    unmount();
  });

  it('renders error state when error is present and no record', () => {
    useRecord.mockReturnValue({ record: null, error: 'Failed to load record' });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Error: Failed to load record');
    unmount();
  });

  it('closes the hierarchy when its record is deleted', () => {
    useRecord.mockReturnValue({ record: null, error: 'record deleted', isDeleted: true });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(hostActions.onClose).toHaveBeenCalledOnce();
    expect(container.childElementCount).toBe(0);
    unmount();
  });

  it('renders processing state when record status is not done', () => {
    useRecord.mockReturnValue({ record: { status: 'pending' }, error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Still processing this page…');
    unmount();
  });

  it('renders TopicHierarchyView and handles click events, plus header close click', () => {
    const mockRecord = {
      status: 'done',
      topics: [{ name: 'Fruit', sentences: [1] }],
      topic_summaries: {},
      topic_summary_index: {},
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    // Header close button
    const closeBtn = container.querySelector('.th-page__close');
    act(() => closeBtn.click());
    expect(hostActions.onClose).toHaveBeenCalledTimes(1);

    const topicLeaf = container.querySelector('.th-leaf');
    act(() => topicLeaf.click());
    expect(hostActions.onNavigateToSentences).toHaveBeenCalledWith({
      key: 'key1',
      rail: 'page',
      sentenceNumbers: [1],
      level: 0,
      topicPath: 'Fruit',
    });

    unmount();
  });

  it('resplits a hierarchy topic using its descendant sentence range and closes on acceptance', async () => {
    useRecord.mockReturnValue({
      record: { status: 'done', topics: [{ name: 'Fruit', sentences: [2, 3] }] },
      error: null,
    });
    const recordSource = { resplitTopic: vi.fn(async () => ({ ok: true })) };
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource }),
    );

    act(() => container.querySelector('.th-node__actions-trigger').click());
    const action = [
      ...document.body.querySelectorAll('.th-node__actions-menu [role="menuitem"]'),
    ].find((item) => item.textContent.includes('Resplit'));
    await act(async () => {
      action.click();
      completeResplitDialog({
        splittingInstructions: 'Split by company.',
        summaryInstructions: 'Focus on ABC.',
      });
    });

    expect(recordSource.resplitTopic).toHaveBeenCalledWith('key1', {
      path: 'Fruit',
      startSentence: 2,
      endSentence: 3,
      splittingInstructions: 'Split by company.',
      summaryInstructions: 'Focus on ABC.',
    });
    expect(hostActions.onClose).toHaveBeenCalledOnce();
    unmount();
  });

  it('keeps topic chat available when the record source cannot resplit', () => {
    useRecord.mockReturnValue({
      record: { status: 'done', topics: [{ name: 'Fruit', sentences: [2, 3] }] },
      error: null,
    });
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource: {} }),
    );

    expect(container.querySelector('.th-node__actions-trigger')).not.toBeNull();
    act(() => container.querySelector('.th-node__actions-trigger').click());
    expect(
      document.body.querySelector('.th-node__actions-menu [role="menuitem"]').textContent,
    ).toBe('To chat');
    unmount();
  });

  it('offers separate Resplit actions for recurring topic runs', async () => {
    useRecord.mockReturnValue({
      record: { status: 'done', topics: [{ name: 'Fruit', sentences: [1, 3] }] },
      error: null,
    });
    const recordSource = { resplitTopic: vi.fn(async () => ({ ok: true })) };
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource }),
    );

    act(() => container.querySelector('.th-node__actions-trigger').click());
    const actions = document.body.querySelectorAll('.th-node__actions-menu [role="menuitem"]');
    expect([...actions].map((action) => action.textContent)).toEqual([
      'To chat',
      'Resplit sentences 1–1',
      'Resplit sentences 3–3',
    ]);
    await act(async () => {
      actions[2].click();
      completeResplitDialog();
    });

    expect(recordSource.resplitTopic).toHaveBeenCalledWith('key1', {
      path: 'Fruit',
      startSentence: 3,
      endSentence: 3,
      splittingInstructions: '',
      summaryInstructions: '',
    });
    expect(hostActions.onClose).toHaveBeenCalledOnce();
    unmount();
  });

  it('does not render redundant fold all or unfold all buttons', () => {
    const mockRecord = {
      status: 'done',
      topics: [
        { name: 'Fruit > Apple', sentences: [1] },
        { name: 'Fruit > Banana', sentences: [2] },
        { name: 'Veggie', sentences: [3] },
      ],
      topic_summaries: {},
      topic_summary_index: {},
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).not.toContain('Fold All');
    expect(container.textContent).not.toContain('Unfold All');
    expect(container.textContent).toContain('Apple');
    expect(container.textContent).toContain('Banana');
    expect(container.querySelector('.th-node--collapsed')).toBeNull();

    unmount();
  });

  it('loads weighted tags on demand and keeps source navigation and summaries available', async () => {
    useRecord.mockReturnValue({
      record: {
        status: 'done',
        topics: [{ name: 'Fruit > Apple', sentences: [1, 3] }],
        topic_summary_index: { 'Fruit>Apple': { runs: [{ text: 'Apple summary' }] } },
      },
      error: null,
    });
    let finish;
    const getTopicTagClouds = vi.fn(() => new Promise((resolve) => (finish = resolve)));
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource: { getTopicTagClouds } }),
    );
    const [summaries, tagClouds] = container.querySelectorAll('[aria-label="Card content"] button');
    expect(summaries.getAttribute('aria-pressed')).toBe('true');
    expect(container.querySelector('.th-leaf-summary').textContent).toBe('Apple summary');
    expect(getTopicTagClouds).not.toHaveBeenCalled();

    act(() => tagClouds.click());
    expect(getTopicTagClouds).toHaveBeenCalledWith('key1', 'pipeline');
    expect(container.querySelector('.th-tag-cloud-notice').textContent).toMatch(/generating/i);

    await act(async () =>
      finish({
        byPath: {
          'Fruit>Apple': [
            { word: 'orchard', weight: 0.99 },
            { word: 'cider', weight: 0.73 },
          ],
          Fruit: [{ word: 'produce', weight: 0.95 }],
        },
      }),
    );
    const [orchard, cider] = container.querySelectorAll('[aria-label="Tags for Fruit>Apple"] li');
    expect(orchard.textContent).toBe('orchard');
    expect(cider.textContent).toBe('cider');
    expect(parseFloat(orchard.style.fontSize)).toBeGreaterThan(parseFloat(cider.style.fontSize));
    expect(container.querySelector('[aria-label="Tags for Fruit"]').textContent).toBe('produce');

    act(() => container.querySelector('.th-leaf').click());
    expect(hostActions.onNavigateToSentences).toHaveBeenCalledWith({
      key: 'key1',
      rail: 'page',
      sentenceNumbers: [1, 3],
      level: 1,
      topicPath: 'Fruit>Apple',
    });

    act(() => container.querySelector('[aria-label="Collapse Fruit"]').click());
    expect(container.querySelector('[aria-label="Tags for Fruit"]').textContent).toBe('produce');
    act(() => summaries.click());
    expect(container.querySelector('.th-tag-cloud')).toBeNull();
    act(() => container.querySelector('[aria-label="Expand Fruit"]').click());
    expect(container.querySelector('.th-leaf-summary').textContent).toBe('Apple summary');
    unmount();
  });

  it('shows saved Pipeline tags without requesting generation', () => {
    useRecord.mockReturnValue({
      record: {
        status: 'done',
        topics: [{ name: 'Fruit > Apple', sentences: [1] }],
        topic_tag_clouds: {
          pipeline: {
            version: TOPIC_TAG_CLOUD_VERSION,
            contentRevision: null,
            topicsRevision: null,
            summaryTreeRevision: null,
            byPath: { 'Fruit>Apple': [{ word: 'orchard', weight: 0.9 }] },
          },
        },
      },
      error: null,
    });
    const getTopicTagClouds = vi.fn();
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource: { getTopicTagClouds } }),
    );
    const [, tagClouds] = container.querySelectorAll('[aria-label="Card content"] button');
    act(() => tagClouds.click());
    expect(container.querySelector('[aria-label="Tags for Fruit>Apple"]').textContent).toBe(
      'orchard',
    );
    expect(container.querySelector('.th-tag-cloud-notice')).toBeNull();
    expect(getTopicTagClouds).not.toHaveBeenCalled();
    unmount();
  });

  it('offers retry after a generation error and reports an empty result', async () => {
    useRecord.mockReturnValue({
      record: { status: 'done', topics: [{ name: 'Fruit', sentences: [1] }] },
      error: null,
    });
    const getTopicTagClouds = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider unavailable'))
      .mockResolvedValueOnce({ byPath: { Fruit: [] } });
    const { container, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource: { getTopicTagClouds } }),
    );
    const [, tagClouds] = container.querySelectorAll('[aria-label="Card content"] button');

    await act(async () => tagClouds.click());
    const alert = container.querySelector('.th-tag-cloud-notice[role="alert"]');
    expect(alert.textContent).toContain('Provider unavailable');
    expect(container.querySelector('.th-leaf')).not.toBeNull();

    await act(async () => alert.querySelector('button').click());
    expect(getTopicTagClouds).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.th-tag-cloud-notice[role="status"]').textContent).toContain(
      'No tags are available',
    );
    unmount();
  });

  it('folds the tree to a chosen level via the level switcher', () => {
    const mockRecord = {
      status: 'done',
      topics: [
        { name: 'Fruit > Citrus > Orange', sentences: [1] },
        { name: 'Fruit > Citrus > Lemon', sentences: [2] },
        { name: 'Veggie', sentences: [3] },
      ],
      topic_summaries: {},
      topic_summary_index: {},
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    const levelButtons = Array.from(
      container.querySelectorAll('.th-hierarchy-level-switcher .topic-level-switcher__button'),
    );
    expect(levelButtons.map((b) => b.textContent)).toEqual(['L0', 'L1', 'L2']);
    expect(levelButtons[2].classList.contains('active')).toBe(true);
    expect(container.textContent).toContain('Orange');
    expect(container.textContent).toContain('Lemon');

    // Pick level 1: branches at depth >= 1 collapse, so Citrus folds and hides
    // its leaves while the level-0 "Fruit"/"Veggie" stay visible.
    act(() => levelButtons[1].click());
    expect(container.textContent).toContain('Citrus');
    expect(container.textContent).not.toContain('Orange');
    expect(container.textContent).not.toContain('Lemon');
    expect(container.querySelector('.th-node--collapsed')).not.toBeNull();

    const activeAfter = container.querySelector(
      '.th-hierarchy-level-switcher .topic-level-switcher__button.active',
    );
    expect(activeAfter.textContent).toBe('L1');

    unmount();
  });

  it('clamps the selected level when an in-place reprocess lowers the maximum level', () => {
    const deepRecord = {
      status: 'done',
      topics: [
        { name: 'Fruit > Citrus > Orange', sentences: [1] },
        { name: 'Veggie', sentences: [2] },
      ],
      topic_summaries: {},
      topic_summary_index: {},
    };
    useRecord.mockReturnValue({ record: deepRecord, error: null });
    const { container, rerender, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1' }),
    );
    const activeLevel = () =>
      container.querySelector('.th-hierarchy-level-switcher .topic-level-switcher__button.active')
        .textContent;
    act(() =>
      Array.from(
        container.querySelectorAll('.th-hierarchy-level-switcher .topic-level-switcher__button'),
      )
        .find((button) => button.textContent === 'L2')
        .click(),
    );
    expect(activeLevel()).toBe('L2');

    useRecord.mockReturnValue({
      record: {
        ...deepRecord,
        topics: [
          { name: 'Fruit > Citrus', sentences: [1] },
          { name: 'Veggie', sentences: [2] },
        ],
      },
      error: null,
    });
    rerender(createElement(HierarchyApp, { initialKey: 'key1' }));

    const labels = Array.from(
      container.querySelectorAll('.th-hierarchy-level-switcher .topic-level-switcher__button'),
    ).map((button) => button.textContent);
    expect(labels).toEqual(['L0', 'L1']);
    expect(activeLevel()).toBe('L1');
    unmount();
  });

  it('resets level, collapsed branches, and summary modal when initialKey changes', () => {
    useRecord.mockReturnValue({
      record: {
        status: 'done',
        topics: [{ name: 'Fruit > Citrus > Orange', sentences: [1] }],
        topic_summary_index: { 'Fruit>Citrus>Orange': { runs: [{ text: 'Orange summary' }] } },
      },
      error: null,
    });
    const { container, rerender, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1' }),
    );

    const buttons = container.querySelectorAll(
      '.th-hierarchy-level-switcher .topic-level-switcher__button',
    );
    act(() => buttons[0].click());
    expect(container.textContent).not.toContain('Orange');
    act(() => buttons[2].click());
    const leafSummary = container.querySelector('.th-leaf-summary');
    act(() => leafSummary.click());
    expect(container.querySelector('.th-summary-modal')).not.toBeNull();

    rerender(createElement(HierarchyApp, { initialKey: 'key2' }));

    expect(container.querySelector('.th-summary-modal')).toBeNull();
    expect(
      container.querySelector('.th-hierarchy-level-switcher .topic-level-switcher__button.active')
        .textContent,
    ).toBe('L2');
    expect(container.textContent).toContain('Orange');
    unmount();
  });

  it('pulls focus into the iframe and scrollable body on mount', () => {
    const focusSpy = vi.spyOn(window, 'focus').mockImplementation(() => {});
    const mockRecord = {
      status: 'done',
      topics: [],
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(focusSpy).toHaveBeenCalled();
    const body = container.querySelector('.th-page__body');
    expect(document.activeElement).toBe(body);

    focusSpy.mockRestore();
    unmount();
  });

  it('closes the modal on Escape keypress', () => {
    const mockRecord = {
      status: 'done',
      topics: [],
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });
    const { unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    act(() => {
      window.dispatchEvent(event);
    });

    expect(hostActions.onClose).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders needs_attention state with a pluralized summary error count', () => {
    useRecord.mockReturnValue({
      record: {
        status: 'needs_attention',
        summaryErrors: [{ topic: 'A' }, { topic: 'B' }],
      },
      error: null,
    });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('2 topics need attention');
    expect(container.textContent).toContain('Open the Options page to retry');

    unmount();
  });

  it('renders pipeline error state read-only, pointing at Options instead of retrying', () => {
    const sendMessageMock = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: sendMessageMock,
      },
    });
    useRecord.mockReturnValue({
      record: { status: 'error', error: 'boom\nstack trace details' },
      error: null,
    });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Processing Failed');
    expect(container.textContent).toContain('boom');

    const details = container.querySelector('.th-page__error-details');
    expect(details).not.toBeNull();
    expect(details.textContent).toContain('stack trace details');

    expect(container.textContent).toContain('Open the Options page to retry');
    expect(container.querySelector('.th-page__retry-btn')).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalled();

    unmount();
  });

  it('opens the summary modal when a summary is clicked, and closes it on close click or Escape', () => {
    const mockRecord = {
      status: 'done',
      topics: [{ name: 'Fruit', sentences: [1] }],
      topic_summary_index: {
        Fruit: { runs: [{ text: 'A delicious collection of fruits.' }] },
      },
    };
    useRecord.mockReturnValue({ record: mockRecord, error: null });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    const summaryEl = container.querySelector('.th-leaf-summary');
    expect(summaryEl).not.toBeNull();
    expect(summaryEl.textContent).toBe('A delicious collection of fruits.');

    act(() => {
      summaryEl.click();
    });

    let modalOverlay = container.querySelector('.th-summary-modal');
    expect(modalOverlay).not.toBeNull();
    expect(container.querySelector('.th-summary-modal__card-path').textContent).toBe('Fruit');
    expect(container.querySelector('.th-summary-modal__card-text').textContent).toBe(
      'A delicious collection of fruits.',
    );

    // Escape closes summary modal instead of entire page modal
    const escapeEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    act(() => {
      window.dispatchEvent(escapeEvent);
    });
    // Modal overlay should be gone
    modalOverlay = container.querySelector('.th-summary-modal');
    expect(modalOverlay).toBeNull();
    expect(hostActions.onClose).not.toHaveBeenCalled();

    act(() => {
      summaryEl.click();
    });
    expect(container.querySelector('.th-summary-modal')).not.toBeNull();

    const closeBtn = container.querySelector('.th-summary-modal__close-btn');
    act(() => {
      closeBtn.click();
    });
    expect(container.querySelector('.th-summary-modal')).toBeNull();

    unmount();
  });

  it('does not re-register its Escape listener when the summary modal toggles', () => {
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');
    useRecord.mockReturnValue({
      record: {
        status: 'done',
        topics: [{ name: 'Fruit', sentences: [1] }],
        topic_summary_index: {
          Fruit: { runs: [{ text: 'A delicious collection of fruits.' }] },
        },
      },
      error: null,
    });

    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));
    const summaryEl = container.querySelector('.th-leaf-summary');
    const listenerCount = (spy) =>
      spy.mock.calls.filter(([eventType]) => eventType === 'keydown').length;

    expect(listenerCount(addEventListenerSpy)).toBe(1);
    expect(listenerCount(removeEventListenerSpy)).toBe(0);

    act(() => summaryEl.click());
    expect(container.querySelector('.th-summary-modal')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('.th-summary-modal')).toBeNull();
    expect(hostActions.onClose).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(hostActions.onClose).toHaveBeenCalledTimes(1);

    expect(listenerCount(addEventListenerSpy)).toBe(1);
    expect(listenerCount(removeEventListenerSpy)).toBe(0);

    unmount();
    expect(listenerCount(removeEventListenerSpy)).toBe(1);
    addEventListenerSpy.mockRestore();
    removeEventListenerSpy.mockRestore();
  });
});

describe('HierarchyApp topic source switcher', () => {
  const summaryTree = (status = 'done', extra = {}) => ({
    version: 1,
    contentRevision: 'rev-a',
    status,
    updatedAt: Date.now(),
    stage: 'done',
    rootId: 'r',
    nodes: {
      p: {
        id: 'p',
        kind: 'passage',
        title: 'Passage',
        children: [],
        sentences: [2],
        segments: [{ text: 'Passage summary', sources: [] }],
      },
      t: { id: 't', kind: 'topic', title: 'Tree topic', children: ['p'], sentences: [2] },
      r: { id: 'r', kind: 'root', title: 'Article', children: ['t'], sentences: [2] },
    },
    ...extra,
  });
  const record = (extra = {}) => ({
    status: 'done',
    contentRevision: 'rev-a',
    topics: [{ name: 'Fruit', sentences: [1] }],
    topic_summary_index: {},
    ...extra,
  });
  const clickSource = (container, label) =>
    act(() =>
      Array.from(
        container.querySelectorAll('.th-hierarchy-source-switcher .topic-level-switcher__button'),
      )
        .find((button) => button.textContent === label)
        .click(),
    );

  beforeEach(() => vi.clearAllMocks());

  it('switches the outline to the summary tree and back', () => {
    useRecord.mockReturnValue({ record: record({ summary_tree: summaryTree() }), error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));
    expect(container.querySelector('.th-hierarchy-source-switcher').textContent).toContain(
      'Topics:',
    );
    expect(container.textContent).toContain('Fruit');

    clickSource(container, 'Summary tree');
    expect(container.textContent).not.toContain('Fruit');
    expect(container.textContent).toContain('Tree topic');
    expect(container.textContent).toContain('Passage summary');

    // Summary tree paths are not record topics, so the page rail gets no topic path.
    act(() => container.querySelector('.th-leaf').click());
    expect(hostActions.onNavigateToSentences).toHaveBeenCalledWith(
      expect.objectContaining({ sentenceNumbers: [2], topicPath: undefined }),
    );

    clickSource(container, 'Pipeline');
    expect(container.textContent).toContain('Fruit');
    unmount();
  });

  it('refreshes tag clouds after an unversioned summary tree changes', async () => {
    const legacyTree = summaryTree('done', { updatedAt: undefined });
    const getTopicTagClouds = vi
      .fn()
      .mockResolvedValueOnce({ byPath: { 'Tree topic': [{ word: 'original', weight: 1 }] } })
      .mockResolvedValueOnce({ byPath: { 'Updated topic': [{ word: 'replacement', weight: 1 }] } });
    const recordSource = { getTopicTagClouds };
    const element = createElement(HierarchyApp, { initialKey: 'key1', recordSource });
    useRecord.mockReturnValue({ record: record({ summary_tree: legacyTree }), error: null });
    const { container, rerender, unmount } = render(element);
    clickSource(container, 'Summary tree');
    const [, tagClouds] = container.querySelectorAll('[aria-label="Card content"] button');
    await act(async () => tagClouds.click());
    expect(getTopicTagClouds).toHaveBeenCalledWith('key1', 'summary_tree');
    expect(container.querySelector('.th-tag-cloud').textContent).toBe('original');

    useRecord.mockReturnValue({
      record: record({ summary_tree: structuredClone(legacyTree) }),
      error: null,
    });
    rerender(cloneElement(element));
    expect(getTopicTagClouds).toHaveBeenCalledTimes(1);

    const updatedTree = structuredClone(legacyTree);
    updatedTree.nodes.t.title = 'Updated topic';
    useRecord.mockReturnValue({ record: record({ summary_tree: updatedTree }), error: null });
    await act(async () => rerender(cloneElement(element)));
    expect(getTopicTagClouds).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.th-tag-cloud').textContent).toBe('replacement');
    unmount();
  });

  it('hides the switcher until the record is done', () => {
    useRecord.mockReturnValue({ record: record({ status: 'pending' }), error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));
    expect(container.querySelector('.th-hierarchy-source-switcher')).toBeNull();
    unmount();
  });

  it('offers a build when no summary tree exists, and shows progress while running', () => {
    const buildSummaryTree = vi.fn(() => Promise.resolve({ ok: true }));
    useRecord.mockReturnValue({ record: record(), error: null });
    const { container, rerender, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1', recordSource: { buildSummaryTree } }),
    );
    clickSource(container, 'Summary tree');
    expect(container.querySelector('.th-page__body').textContent).toMatch(/No summary tree/);
    act(() =>
      Array.from(container.querySelectorAll('.tt-btn'))
        .find((button) => button.textContent === 'Build summary tree')
        .click(),
    );
    expect(buildSummaryTree).toHaveBeenCalledWith('key1', { fresh: false });

    useRecord.mockReturnValue({
      record: record({ summary_tree: summaryTree('running') }),
      error: null,
    });
    rerender(
      createElement(HierarchyApp, {
        ...hostActions,
        initialKey: 'key1',
        recordSource: { buildSummaryTree },
      }),
    );
    expect(container.querySelector('.th-page__body').textContent).toMatch(/being built/);
    unmount();
  });

  it('resets level state and closes topic chat when summary tree updates or rebuilds', async () => {
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage: vi.fn((_message, callback) => callback?.({ ok: true, chats: [] })),
      },
    });
    const initialTree = summaryTree('done', { updatedAt: 1000 });
    useRecord.mockReturnValue({
      record: record({ summary_tree: initialTree }),
      error: null,
    });
    const { container, rerender, unmount } = render(
      createElement(HierarchyApp, { initialKey: 'key1' }),
    );

    clickSource(container, 'Summary tree');
    expect(container.textContent).toContain('Tree topic');

    // Select level 0
    const levelButtons = Array.from(
      container.querySelectorAll('.th-hierarchy-level-switcher .topic-level-switcher__button'),
    );
    expect(levelButtons.map((b) => b.textContent)).toEqual(['L0', 'L1']);
    expect(levelButtons[1].classList.contains('active')).toBe(true);
    act(() => levelButtons[0].click());
    expect(
      container.querySelector('.th-hierarchy-level-switcher .topic-level-switcher__button.active')
        .textContent,
    ).toBe('L0');

    // Open topic chat
    act(() => container.querySelector('.th-node__actions-trigger').click());
    const toChat = [
      ...document.body.querySelectorAll('.th-node__actions-menu [role="menuitem"]'),
    ].find((item) => item.textContent.includes('To chat'));
    await act(async () => {
      toChat.click();
    });
    expect(container.querySelector('.th-chat-panel')).not.toBeNull();

    // Rerender with a record whose summary tree has a new updatedAt revision
    useRecord.mockReturnValue({
      record: record({ summary_tree: summaryTree('done', { updatedAt: 2000 }) }),
      error: null,
    });
    rerender(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.querySelector('.th-chat-panel')).toBeNull();
    expect(
      container.querySelector('.th-hierarchy-level-switcher .topic-level-switcher__button.active')
        .textContent,
    ).toBe('L1');

    // Select level 0 and open chat again
    const updatedButtons = Array.from(
      container.querySelectorAll('.th-hierarchy-level-switcher .topic-level-switcher__button'),
    );
    act(() => updatedButtons[0].click());
    expect(
      container.querySelector('.th-hierarchy-level-switcher .topic-level-switcher__button.active')
        .textContent,
    ).toBe('L0');
    act(() => container.querySelector('.th-node__actions-trigger').click());
    const toChatAgain = [
      ...document.body.querySelectorAll('.th-node__actions-menu [role="menuitem"]'),
    ].find((item) => item.textContent.includes('To chat'));
    await act(async () => {
      toChatAgain.click();
    });
    expect(container.querySelector('.th-chat-panel')).not.toBeNull();

    // Rerender with running summary tree
    useRecord.mockReturnValue({
      record: record({ summary_tree: summaryTree('running') }),
      error: null,
    });
    rerender(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.querySelector('.th-chat-panel')).toBeNull();

    unmount();
  });
});
