// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import HierarchyApp from './HierarchyApp.jsx';
import { useRecord } from '../useRecord.js';

vi.mock('../useRecord.js', () => ({
  useRecord: vi.fn(),
}));

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

describe('HierarchyApp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('parent', {
      postMessage: vi.fn(),
    });
  });

  it('renders loading state when record is null and no error', () => {
    useRecord.mockReturnValue({ record: null, error: null });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Loading…');
    unmount();
  });

  it('renders error state when error is present and no record', () => {
    useRecord.mockReturnValue({ record: null, error: 'Failed to load record' });
    const { container, unmount } = render(createElement(HierarchyApp, { initialKey: 'key1' }));

    expect(container.textContent).toContain('Error: Failed to load record');
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
    expect(window.parent.postMessage).toHaveBeenCalledWith({ type: 'pagetollm-close' }, '*');

    // Topic click
    const topicLeaf = container.querySelector('.th-leaf');
    act(() => topicLeaf.click());
    expect(window.parent.postMessage).toHaveBeenCalledWith(
      {
        type: 'pagetollm-scroll-to-topic-sentences',
        key: 'key1',
        sentenceNumbers: [1],
        level: 0,
        topicPath: 'Fruit',
      },
      '*',
    );

    unmount();
  });

  it('renders pipeline error state and triggers retry', () => {
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

    const retryBtn = container.querySelector('.th-page__retry-btn');
    act(() => retryBtn.click());
    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: 'retryRecord', key: 'key1' },
      expect.any(Function),
    );

    unmount();
  });
});
