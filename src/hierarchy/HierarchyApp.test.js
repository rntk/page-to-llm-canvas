// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cloneElement, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import HierarchyApp from './HierarchyApp.jsx';
import { useRecord } from '../canvas/hooks/useRecord.js';

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

    // Topic click
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

    // Starts fully unfolded with the deepest (leaf) level selected.
    const levelButtons = Array.from(
      container.querySelectorAll('.th-page__level-switcher .topic-level-switcher__button'),
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
      '.th-page__level-switcher .topic-level-switcher__button.active',
    );
    expect(activeAfter.textContent).toBe('L1');

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

    // Verify summary is rendered
    const summaryEl = container.querySelector('.th-leaf-summary');
    expect(summaryEl).not.toBeNull();
    expect(summaryEl.textContent).toBe('A delicious collection of fruits.');

    // Click summary to open modal
    act(() => {
      summaryEl.click();
    });

    // Verify modal overlay is rendered
    let modalOverlay = container.querySelector('.th-summary-modal-overlay');
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
    modalOverlay = container.querySelector('.th-summary-modal-overlay');
    expect(modalOverlay).toBeNull();
    // Verify the entire page modal was not closed.
    expect(hostActions.onClose).not.toHaveBeenCalled();

    // Click again to reopen
    act(() => {
      summaryEl.click();
    });
    expect(container.querySelector('.th-summary-modal-overlay')).not.toBeNull();

    // Click close button inside modal
    const closeBtn = container.querySelector('.th-summary-modal__close-btn');
    act(() => {
      closeBtn.click();
    });
    expect(container.querySelector('.th-summary-modal-overlay')).toBeNull();

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
    expect(container.querySelector('.th-summary-modal-overlay')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('.th-summary-modal-overlay')).toBeNull();
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
