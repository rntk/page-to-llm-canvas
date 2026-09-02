// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Minimal CSS Custom Highlight API polyfill (happy-dom ships neither Highlight
// nor CSS.highlights); mirrors the one in controller.test.jsx.
class FakeHighlight {
  constructor() {
    this.ranges = new Set();
  }
  add(range) {
    this.ranges.add(range);
  }
}

// The adapter's only DOM dependency worth faking: a range whose rect places the
// sentence 500px down the viewport.
function fakeRange(top = 500) {
  return {
    getBoundingClientRect: () => ({ top, left: 0, width: 10, height: 10 }),
  };
}

vi.mock('../../../highlights/sentenceHighlight.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildSentenceDomRange: vi.fn() };
});

const { createPageHighlighter } = await import('./pageHighlighter.js');
const {
  buildSentenceDomRange,
  HIGHLIGHT_NAME,
  CHAT_HIGHLIGHT_NAME,
  collectWordEntries,
  buildSentenceWordRanges,
} = await import('../../../highlights/sentenceHighlight.js');

const SENTENCES = [
  'Alpha one.',
  'Beta two.',
  'Gamma three.',
  'Delta four.',
  'Epsilon five.',
  'Zeta six.',
];

/**
 * paintSentenceHighlight builds its Ranges through the real (module-internal)
 * buildSentenceDomRange, so the highlight tests need genuine word entries over
 * a mounted article rather than empty stubs.
 */
function mountArticle() {
  const el = document.createElement('div');
  el.id = 'article';
  el.textContent = SENTENCES.join(' ');
  document.body.appendChild(el);
  const wordEntries = collectWordEntries([el]);
  return { wordEntries, sentenceRanges: buildSentenceWordRanges(SENTENCES, wordEntries) };
}

function makeHighlighter(overrides = {}) {
  return createPageHighlighter({
    ...mountArticle(),
    scrollContainer: window,
    window,
    ...overrides,
  });
}

/** Sentence numbers painted under a highlight name, via the recorded ranges. */
function paintedCount(name) {
  return CSS.highlights.get(name)?.ranges.size ?? 0;
}

describe('createPageHighlighter', () => {
  afterEach(() => {
    document.getElementById('article')?.remove();
  });

  beforeEach(() => {
    vi.stubGlobal('CSS', { highlights: new Map() });
    vi.stubGlobal('Highlight', FakeHighlight);
    window.scrollTo = vi.fn();
    buildSentenceDomRange.mockReset();
    // A distinct range object per sentence so the fake Highlight's Set counts
    // sentences rather than deduping one shared object.
    buildSentenceDomRange.mockImplementation((_ranges, _entries, sNum) => fakeRange(500 + sNum));
  });

  it('paints topic and chat sentences as two separate named highlights', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightTopic([1, 2], true);
    highlighter.highlightChatRange(4, 6);

    expect(paintedCount(HIGHLIGHT_NAME)).toBe(2);
    expect(paintedCount(CHAT_HIGHLIGHT_NAME)).toBe(3);
  });

  it('does not rebuild chat ranges when topic highlights change', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightChatRange(4, 6);
    const chatHighlight = CSS.highlights.get(CHAT_HIGHLIGHT_NAME);

    highlighter.highlightTopic([1, 2], true);
    highlighter.highlightTopic([1, 2], false);

    expect(CSS.highlights.get(CHAT_HIGHLIGHT_NAME)).toBe(chatHighlight);
  });

  it('does not rebuild topic ranges when chat highlights change', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightTopic([1, 2], true);
    const topicHighlight = CSS.highlights.get(HIGHLIGHT_NAME);

    highlighter.highlightChatRange(4, 6);
    highlighter.clearChatHighlights();

    expect(CSS.highlights.get(HIGHLIGHT_NAME)).toBe(topicHighlight);
  });

  it('highlightChatRange covers the range inclusively', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightChatRange(2, 2);
    expect(paintedCount(CHAT_HIGHLIGHT_NAME)).toBe(1);

    highlighter.highlightChatRange(2, 4);
    expect(paintedCount(CHAT_HIGHLIGHT_NAME)).toBe(3);
  });

  it('turning a topic highlight off removes only those sentences', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightTopic([1, 2, 3], true);
    highlighter.highlightTopic([2], false);
    expect(paintedCount(HIGHLIGHT_NAME)).toBe(2);

    highlighter.highlightTopic([1, 3], false);
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
  });

  it('clearChatHighlights leaves the topic highlight intact', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightTopic([1], true);
    highlighter.highlightChatRange(3, 4);
    highlighter.clearChatHighlights();

    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
    expect(paintedCount(HIGHLIGHT_NAME)).toBe(1);
  });

  it('clearAll empties both highlight sets', () => {
    const highlighter = makeHighlighter();

    highlighter.highlightTopic([1], true);
    highlighter.highlightChatRange(3, 4);
    highlighter.clearAll();

    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
  });

  describe('scrollToFirst', () => {
    it('centres the first sentence in the window when the page is the scroller', () => {
      makeHighlighter().scrollToFirst([7, 8]);

      expect(buildSentenceDomRange).toHaveBeenCalledWith(expect.anything(), expect.anything(), 7);
      expect(window.scrollTo).toHaveBeenCalledWith({
        top: 507 + window.scrollY - window.innerHeight / 2,
        behavior: 'smooth',
      });
    });

    it('scrolls a nested scroll container relative to its own box', () => {
      const scrollContainer = document.createElement('div');
      scrollContainer.getBoundingClientRect = () => ({ top: 100 });
      Object.defineProperty(scrollContainer, 'clientHeight', { value: 400 });
      scrollContainer.scrollTop = 250;
      scrollContainer.scrollTo = vi.fn();

      makeHighlighter({ scrollContainer }).scrollToFirst([1]);

      // 501 (range top) - 100 (container top) - 200 (half viewport) + 250 scrollTop
      expect(scrollContainer.scrollTo).toHaveBeenCalledWith({ top: 451, behavior: 'smooth' });
      expect(window.scrollTo).not.toHaveBeenCalled();
    });

    it('does nothing without sentences, a range, or a laid-out rect', () => {
      const highlighter = makeHighlighter();

      highlighter.scrollToFirst([]);
      highlighter.scrollToFirst(undefined);
      expect(buildSentenceDomRange).not.toHaveBeenCalled();

      buildSentenceDomRange.mockReturnValueOnce(null);
      highlighter.scrollToFirst([1]);

      buildSentenceDomRange.mockReturnValueOnce({
        getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
      });
      highlighter.scrollToFirst([1]);

      expect(window.scrollTo).not.toHaveBeenCalled();
    });
  });

  describe('onViewportResize', () => {
    let frames;
    beforeEach(() => {
      frames = [];
      vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', vi.fn());
    });

    it('coalesces bursts of resizes into a single animation frame', () => {
      const onResize = vi.fn();
      makeHighlighter().onViewportResize(onResize);

      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('resize'));
      expect(frames).toHaveLength(1);
      expect(onResize).not.toHaveBeenCalled();

      frames.shift()();
      expect(onResize).toHaveBeenCalledTimes(1);

      // The frame is released, so a later resize schedules a fresh one.
      window.dispatchEvent(new Event('resize'));
      expect(frames).toHaveLength(1);
    });

    it('destroy detaches the listener and cancels a pending frame', () => {
      const onResize = vi.fn();
      const highlighter = makeHighlighter();
      highlighter.onViewportResize(onResize);

      window.dispatchEvent(new Event('resize'));
      highlighter.destroy();

      expect(cancelAnimationFrame).toHaveBeenCalled();
      window.dispatchEvent(new Event('resize'));
      // No new frame scheduled after destroy, and the pending one is dropped.
      expect(frames).toHaveLength(1);
      frames.shift()();
      expect(onResize).toHaveBeenCalledTimes(1);
    });
  });

  it('destroy removes both highlights and is safe with no resize subscription', () => {
    const highlighter = makeHighlighter();
    highlighter.highlightTopic([1], true);
    highlighter.highlightChatRange(2, 3);

    expect(() => highlighter.destroy()).not.toThrow();
    expect(CSS.highlights.has(HIGHLIGHT_NAME)).toBe(false);
    expect(CSS.highlights.has(CHAT_HIGHLIGHT_NAME)).toBe(false);
  });
});
