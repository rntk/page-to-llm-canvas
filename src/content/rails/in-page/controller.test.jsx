// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Minimal CSS Custom Highlight API polyfill (happy-dom ships neither Highlight
// nor CSS.highlights). Highlight just records the live Ranges added to it, so
// tests can assert on rebuildHighlight()'s output without a real layout engine.
class FakeHighlight {
  constructor() {
    this.ranges = new Set();
  }
  add(range) {
    this.ranges.add(range);
  }
}

vi.stubGlobal('chrome', {
  runtime: {
    sendMessage: vi.fn((_msg, cb) => cb({ ok: false })),
    getURL: vi.fn((p) => 'about:blank#' + p),
    lastError: null,
  },
  storage: {
    local: { get: vi.fn((_key, cb) => cb({})) },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
});

vi.mock('../../record-view/iframeManager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    openCanvasIframe: vi.fn(),
    openHierarchyIframe: vi.fn(),
    removeCanvasIframe: vi.fn(),
  };
});

vi.mock('../shared/recordFetch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchRecord: vi.fn() };
});

vi.mock('./geometry.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getScrollableAncestor: vi.fn(() => window),
    getRailOriginTop: vi.fn(() => 100),
    computeCardVerticalBox: vi.fn(() => ({ top: 0, height: 50 })),
  };
});

vi.mock('../../../highlights/sentenceHighlight.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    buildSentenceDomRange: vi.fn(() => ({
      getBoundingClientRect: () => ({ top: 500, left: 0, width: 10, height: 10 }),
    })),
  };
});

const { openInPageRail } = await import('./controller.jsx');
const { fetchRecord } = await import('../shared/recordFetch.js');
const { openCanvasIframe, openHierarchyIframe } =
  await import('../../record-view/iframeManager.js');
const { closeInPageRail, railLoadingTokenHolder } = await import('../shared/surface.js');
const { buildSentenceDomRange } = await import('../../../highlights/sentenceHighlight.js');

function baseRecord(overrides = {}) {
  return {
    key: 'rail-key',
    status: 'done',
    selectors: ['#article'],
    sentences: ['Alpha sentence.', 'Beta sentence.'],
    topics: [{ name: 'Parent > Child', sentences: [1, 2] }],
    topic_summary_index: {
      'Parent > Child': {
        level: 1,
        runs: [{ sentences: [1, 2], text: 'Summary text' }],
        source_sentences: [1, 2],
      },
    },
    ...overrides,
  };
}

function mountArticle() {
  const el = document.createElement('div');
  el.id = 'article';
  el.textContent = 'Alpha sentence. Beta sentence.';
  document.body.appendChild(el);
  return el;
}

function rail() {
  return document.getElementById('pagetollm-in-page-rail');
}

describe('openInPageRail', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal(
      'confirm',
      vi.fn(() => false),
    );
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('CSS', { highlights: new Map() });
    vi.stubGlobal('Highlight', FakeHighlight);
    window.scrollTo = vi.fn();
    fetchRecord.mockReset();
    openCanvasIframe.mockClear();
    openHierarchyIframe.mockClear();
    globalThis.chrome.runtime.sendMessage.mockClear();
    globalThis.chrome.runtime.sendMessage.mockImplementation((_msg, cb) => cb({ ok: false }));
  });

  afterEach(() => {
    closeInPageRail();
    railLoadingTokenHolder.current = null;
    document.getElementById('article')?.remove();
    document.getElementById('pagetollm-canvas-iframe')?.remove();
  });

  it('alerts when the record is not found', async () => {
    fetchRecord.mockResolvedValue(null);
    await act(async () => {
      await openInPageRail({ key: 'missing' }, 'topics');
    });
    expect(alert).toHaveBeenCalledWith('PageToLLM: Analysis record not found.');
    expect(rail()).toBeNull();
  });

  it('on error status: confirming retry retries and opens the canvas', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ status: 'error', error: 'Boom failed' }));
    confirm.mockReturnValue(true);
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'retryRecord') return cb({ ok: true });
      cb({ ok: false });
    });

    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });

    expect(confirm).toHaveBeenCalled();
    expect(confirm.mock.calls[0][0]).toContain('Boom failed');
    expect(openCanvasIframe).toHaveBeenCalledWith('rail-key');
  });

  it('on error status: a failed retry alerts instead of opening the canvas', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ status: 'error', error: 'Boom failed' }));
    confirm.mockReturnValue(true);
    globalThis.chrome.runtime.sendMessage.mockImplementation((msg, cb) => {
      if (msg.type === 'retryRecord') return cb({ ok: false, error: 'server exploded' });
      cb({ ok: false });
    });

    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });

    expect(openCanvasIframe).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('server exploded'));
  });

  it('on error status: declining the retry confirm does nothing further', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ status: 'error', error: 'Boom failed' }));
    confirm.mockReturnValue(false);

    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });

    expect(openCanvasIframe).not.toHaveBeenCalled();
    expect(globalThis.chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('needs_attention: confirming opens the canvas, declining does not', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ status: 'needs_attention' }));
    confirm.mockReturnValue(false);
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(openCanvasIframe).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(openCanvasIframe).toHaveBeenCalledWith('rail-key');
  });

  it('alerts with the processing stage when the record is in progress', async () => {
    fetchRecord.mockResolvedValue(
      baseRecord({ status: 'processing', progress: { stage: 'summarizing' } }),
    );
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('summarizing'));
  });

  it('no_selectors: confirming opens the canvas as a fallback', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ selectors: [] }));
    confirm.mockReturnValue(true);
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(confirm.mock.calls[0][0]).toContain('no saved selectors');
    expect(openCanvasIframe).toHaveBeenCalledWith('rail-key');
  });

  it('no_selectors: declining the confirm leaves nothing open', async () => {
    fetchRecord.mockResolvedValue(baseRecord({ selectors: [] }));
    confirm.mockReturnValue(false);
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(openCanvasIframe).not.toHaveBeenCalled();
    expect(rail()).toBeNull();
  });

  it('falls back to the canvas view when the picked elements are not found on the page', async () => {
    // No matching #article element mounted, so findPickedElements() returns [].
    fetchRecord.mockResolvedValue(baseRecord());
    confirm.mockReturnValue(true);
    await act(async () => {
      await openInPageRail({ key: 'rail-key' }, 'topics');
    });
    expect(confirm.mock.calls[0][0]).toContain('page layout may have changed');
    expect(openCanvasIframe).toHaveBeenCalledWith('rail-key');
  });

  it('aborts a stale load when a newer rail request wins the race', async () => {
    let resolveFirst;
    fetchRecord.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mountArticle();

    const firstCall = openInPageRail({ key: 'first' }, 'topics');
    // A second call starts loading before the first resolves, invalidating it.
    fetchRecord.mockResolvedValueOnce(null);
    const secondCall = openInPageRail({ key: 'second' }, 'topics');

    await act(async () => {
      resolveFirst(baseRecord({ key: 'first' }));
      await Promise.all([firstCall, secondCall]);
    });

    // Neither the stale first load nor the not_found second load renders a rail.
    expect(rail()).toBeNull();
    expect(alert).toHaveBeenCalledWith('PageToLLM: Analysis record not found.');
  });

  describe('ready path', () => {
    beforeEach(() => {
      mountArticle();
      fetchRecord.mockResolvedValue(baseRecord());
    });

    it('renders the rail in the requested initial mode', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      expect(rail()).not.toBeNull();
      expect(rail().dataset.mode).toBe('topics');
      expect(rail().style.position).toBe('absolute');
    });

    it('keeps the chat rail fixed while switching between rail modes', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'chat');
      });
      expect(rail().style.position).toBe('fixed');
      expect(rail().style.bottom).toBe('0px');

      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'topics';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(rail().style.position).toBe('absolute');
      expect(rail().style.bottom).toBe('');

      await act(async () => {
        select.value = 'chat';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(rail().style.position).toBe('fixed');
      expect(rail().style.bottom).toBe('0px');
    });

    it('switching to canvas mode closes the rail and opens the canvas iframe', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'canvas';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(openCanvasIframe).toHaveBeenCalledWith('rail-key');
      expect(rail()).toBeNull();
    });

    it('switching to hierarchy mode closes the rail and opens the hierarchy iframe', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'hierarchy';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(openHierarchyIframe).toHaveBeenCalledWith('rail-key');
      expect(rail()).toBeNull();
    });

    it('switching to summaries mode updates the rail dataset without opening an iframe', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'summaries';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(rail()).not.toBeNull();
      expect(rail().dataset.mode).toBe('summaries');
      expect(openCanvasIframe).not.toHaveBeenCalled();
      expect(openHierarchyIframe).not.toHaveBeenCalled();
    });

    it('grows the rail body in summaries mode so the last summary keeps a background', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const body = () => rail().querySelector('.pagetollm-rail-body');
      // Topics mode pads the lowest card box by a flat 80px.
      const topicsHeight = Number.parseFloat(body().style.height);
      const cardsBottom = topicsHeight - 80;

      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'summaries';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      // The fixture's only summary sits at level 1; without this the summary
      // card set is empty and the body falls back to its fixed 200px.
      await act(async () => {
        rail().querySelector('.pagetollm-rail-level-btn[data-level="1"]').click();
      });

      // The summary column is fixed to the viewport, so the rail must reserve
      // everything from the cursor line down to the bottom of the viewport.
      const cursorTop = Math.max(112, Math.round(window.innerHeight * 0.38));
      const expected = cardsBottom + Math.max(80, window.innerHeight - cursorTop);
      expect(body().style.height).toBe(`${expected}px`);
      expect(expected).toBeGreaterThan(topicsHeight);
    });

    it('switching level updates the active level button', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const buttons = rail().querySelectorAll('.pagetollm-rail-level-btn');
      expect(buttons.length).toBeGreaterThan(1);
      const level1Btn = rail().querySelector('.pagetollm-rail-level-btn[data-level="1"]');
      await act(async () => {
        level1Btn.click();
      });
      expect(rail().querySelector('.pagetollm-rail-level-btn[data-level="1"]').className).toContain(
        'active',
      );
    });

    it('highlights and scrolls to sentenceNumbers passed via options inside requestAnimationFrame', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics', { sentenceNumbers: [1], level: 1 });
      });

      expect(buildSentenceDomRange).toHaveBeenCalled();
      expect(CSS.highlights.has('pagetollm-sentence')).toBe(true);
      expect(window.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }));
      // options.level seeds the initial selectedLevel.
      expect(rail().querySelector('.pagetollm-rail-level-btn[data-level="1"]').className).toContain(
        'active',
      );
    });

    it('hovering a card highlights its sentences and clicking it scrolls to them', async () => {
      await act(async () => {
        await openInPageRail({ key: 'rail-key' }, 'topics');
      });
      const card = rail().querySelector('.pagetollm-rail-card');
      expect(card).not.toBeNull();

      await act(async () => {
        card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      expect(CSS.highlights.has('pagetollm-sentence')).toBe(true);

      await act(async () => {
        card.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      expect(CSS.highlights.has('pagetollm-sentence')).toBe(false);

      await act(async () => {
        card.click();
      });
      expect(window.scrollTo).toHaveBeenCalled();
    });
  });
});
