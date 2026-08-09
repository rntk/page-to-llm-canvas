// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useCanvasRecordViewModel } from './useCanvasRecordViewModel.js';

function setup(initialProps) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const apiRef = { current: null };
  let props = initialProps;

  function Harness() {
    apiRef.current = useCanvasRecordViewModel(props);
    return null;
  }

  act(() => root.render(createElement(Harness)));
  return {
    apiRef,
    rerender(nextProps) {
      props = { ...props, ...nextProps };
      act(() => root.render(createElement(Harness)));
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cleanups = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe('useCanvasRecordViewModel', () => {
  it('normalizes article data and derives topic metadata', () => {
    const record = {
      status: 'done',
      html: '<p>First sentence. Second sentence.</p>',
      topics: [{ name: 'Technology > AI', sentences: [1, 2] }],
      sentences: ['First sentence.', 'Second sentence.'],
      topic_summary_index: {
        'Technology > AI': {
          level: 1,
          source_sentences: [1, 2],
          runs: [{ sentences: [1, 2], text: 'AI summary' }],
        },
      },
    };
    const { apiRef, cleanup } = setup({
      record,
      selectedLevel: 1,
      showSummaryModeRaw: false,
    });
    cleanups.push(cleanup);

    expect(apiRef.current.articleHtml).toBe('<p>First sentence. Second sentence.</p>');
    expect(apiRef.current.maxLevel).toBe(1);
    expect(apiRef.current.topicSentenceIndex.get('Technology')).toEqual(new Set([1, 2]));
    expect(apiRef.current.summaryCards).toHaveLength(1);
  });

  it('forces summary mode off when summaries become disabled', () => {
    const record = { status: 'done', summariesDisabled: false };
    const ctx = setup({
      record,
      selectedLevel: 0,
      showSummaryModeRaw: true,
    });
    cleanups.push(ctx.cleanup);
    expect(ctx.apiRef.current.showSummaryMode).toBe(true);

    ctx.rerender({ record: { ...record, summariesDisabled: true } });
    expect(ctx.apiRef.current.showSummaryMode).toBe(false);
  });
});
