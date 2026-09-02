// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

vi.mock('../shared/recordFetch.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchRecord: vi.fn() };
});

vi.mock('../../record-view/iframeManager.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, removeCanvasIframe: vi.fn() };
});

vi.mock('./sync.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, buildYouTubeRailCards: vi.fn() };
});

const { createYouTubeRailController } = await import('./controller.jsx');
const { fetchRecord } = await import('../shared/recordFetch.js');
const { buildYouTubeRailCards } = await import('./sync.js');
const { createRailSurfaceManager } = await import('../shared/surface.js');
const preferences = await import('../../shared/surfacePreferences.js');
const surfaceManager = createRailSurfaceManager({ document, preferences });
const closeInPageRail = surfaceManager.close;
const logger = { warn: vi.fn() };
const { openYouTubeRail } = createYouTubeRailController({
  surfaceManager,
  document,
  runtimeMessenger: { send: vi.fn() },
  dialogs: { alert: (...args) => globalThis.alert(...args) },
  logger,
});

function baseRecord(overrides = {}) {
  return {
    key: 'yt-key',
    status: 'done',
    sourceUrl: 'https://www.youtube.com/watch?v=abc123',
    sentences: ['Intro sentence.', 'Middle sentence.'],
    topics: [
      { name: 'Parent > Intro', sentences: [1] },
      { name: 'Parent > Middle', sentences: [2] },
    ],
    topic_summary_index: {
      'Parent > Intro': { level: 1, runs: [{ sentences: [1], text: 'Intro summary' }] },
      'Parent > Middle': { level: 1, runs: [] },
    },
    ...overrides,
  };
}

const found = (record) => ({ kind: 'found', record });

const twoCards = [
  {
    id: 'a',
    name: 'Intro',
    path: 'Parent > Intro',
    text: 'Intro summary',
    accent: '#a11',
    seconds: 0,
    sentences: [1],
  },
  {
    id: 'b',
    name: 'Middle',
    path: 'Parent > Middle',
    text: '',
    accent: '#1a1',
    seconds: 30,
    sentences: [2],
  },
];

function rail() {
  return document.getElementById('pagetollm-in-page-rail');
}

function mountVideo() {
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  let time = 0;
  Object.defineProperty(video, 'currentTime', {
    get: () => time,
    set: (next) => {
      time = next;
    },
    configurable: true,
  });
  video.play = vi.fn(() => Promise.resolve());
  document.body.appendChild(video);
  return video;
}

async function flushAsyncWork() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

describe('openYouTubeRail', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    globalThis.chrome.runtime.sendMessage.mockImplementation((_msg, cb) => cb({ ok: false }));
    fetchRecord.mockReset();
    logger.warn.mockClear();
    buildYouTubeRailCards.mockReset();
    buildYouTubeRailCards.mockReturnValue(twoCards);
  });

  afterEach(() => {
    closeInPageRail();
    document.querySelector('video')?.remove();
  });

  it('alerts when the record is not found', async () => {
    fetchRecord.mockResolvedValue({ kind: 'not_found' });
    await act(async () => {
      await openYouTubeRail({ key: 'missing' });
    });
    expect(alert).toHaveBeenCalledWith('PageToLLM: Analysis record not found.');
    expect(rail()).toBeNull();
  });

  it('reports a transport failure separately from a missing record', async () => {
    fetchRecord.mockResolvedValue({ kind: 'transport_error', error: new Error('disconnected') });

    await act(async () => {
      await openYouTubeRail({ key: 'unavailable' });
    });

    expect(alert).toHaveBeenCalledWith(
      'PageToLLM: Could not load the analysis record. Please try again.',
    );
    expect(logger.warn).toHaveBeenCalledWith('record fetch failed:', expect.any(Error));
  });

  it('alerts with the record status when analysis is not done', async () => {
    fetchRecord.mockResolvedValue(found(baseRecord({ status: 'processing' })));
    await act(async () => {
      await openYouTubeRail({ key: 'yt-key' });
    });
    expect(alert).toHaveBeenCalledWith(expect.stringContaining('processing'));
    expect(rail()).toBeNull();
  });

  it('alerts when there are no transcript topics to sync with the video', async () => {
    fetchRecord.mockResolvedValue(found(baseRecord({ topics: [], topic_summary_index: null })));
    await act(async () => {
      await openYouTubeRail({ key: 'yt-key' });
    });
    expect(alert).toHaveBeenCalledWith(
      'PageToLLM: This analysis has no transcript topics to sync with the video.',
    );
    expect(rail()).toBeNull();
  });

  describe('ready path', () => {
    beforeEach(() => {
      fetchRecord.mockResolvedValue(found(baseRecord()));
    });

    it('renders the rail tagged as a youtube rail in topics mode', async () => {
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      expect(rail()).not.toBeNull();
      expect(rail().dataset.youtube).toBe('true');
      expect(rail().dataset.mode).toBe('topics');
      expect(rail().querySelectorAll('.pagetollm-yt-rail-card')).toHaveLength(2);
    });

    it('switching mode updates the rail dataset and re-requests cards', async () => {
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      buildYouTubeRailCards.mockClear();
      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'summaries';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(rail().dataset.mode).toBe('summaries');
      expect(buildYouTubeRailCards).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'summaries', selectedLevel: 0 }),
      );
    });

    function mockChatWithStoredEvent() {
      fetchRecord.mockResolvedValue(
        found(
          baseRecord({
            sentences: ['0:00 0 seconds Intro sentence.', '0:30 30 seconds Middle sentence.'],
          }),
        ),
      );
      globalThis.chrome.runtime.sendMessage.mockImplementation((message, callback) => {
        if (message.type === 'listChats') {
          callback({
            ok: true,
            chats: [
              {
                chatId: 'chat-1',
                title: 'Video question',
                updatedAt: 1,
                messageCount: 0,
                eventCount: 1,
              },
            ],
          });
          return;
        }
        if (message.type === 'getChat') {
          callback({
            ok: true,
            chat: {
              chatId: 'chat-1',
              messages: [],
              events: [
                {
                  seq: 1,
                  eventType: 'highlight_span',
                  data: { startLine: 2, endLine: 2, label: 'Middle evidence' },
                },
              ],
            },
          });
          return;
        }
        callback({ ok: false });
      });
    }

    async function openChatModeRail() {
      const video = mountVideo();
      mockChatWithStoredEvent();

      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const select = rail().querySelector('.pagetollm-rail-mode-select');
      await act(async () => {
        select.value = 'chat';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flushAsyncWork();

      return video;
    }

    async function openEventsTab() {
      const video = await openChatModeRail();
      const eventsTab = Array.from(rail().querySelectorAll('.pagetollm-chat-tabs button')).find(
        (button) => button.textContent.includes('Events'),
      );
      await act(async () => eventsTab.click());
      return { video, eventsTab };
    }

    it('switches to chat mode and renders the chat header', async () => {
      await openChatModeRail();

      expect(rail().dataset.mode).toBe('chat');
      expect(rail().style.position).toBe('');
      expect(rail().style.width).toBe('380px');
      expect(rail().querySelector('.pagetollm-chat').getAttribute('aria-label')).toBe(
        'Video assistant',
      );
      expect(document.activeElement).toBe(
        rail().querySelector('.pagetollm-chat-composer textarea'),
      );
      expect(rail().querySelector('.pagetollm-rail-level-switcher')).toBeNull();
    });

    it('selects the Events tab with the correct ARIA attributes', async () => {
      const { eventsTab } = await openEventsTab();

      expect(eventsTab.getAttribute('role')).toBe('tab');
      expect(eventsTab.getAttribute('aria-selected')).toBe('true');
    });

    it('renders the rail close button and does not seek until the event is clicked', async () => {
      const { video } = await openEventsTab();

      expect(rail().querySelector('.pagetollm-rail-close').getAttribute('aria-label')).toBe(
        'Close rail',
      );
      // Loading the selected event is passive; it must not jump until the user
      // clicks it.
      expect(video.currentTime).toBe(0);
    });

    it('seeks the video and shows status when a stored event is clicked', async () => {
      const { video } = await openEventsTab();

      const eventButton = rail().querySelector('.pagetollm-chat-event > button');
      expect(eventButton.textContent).toContain('Jump to 0:30');
      await act(async () => eventButton.click());
      await flushAsyncWork();
      expect(video.currentTime).toBe(30);
      expect(video.play).toHaveBeenCalled();
      expect(rail().querySelector('.pagetollm-chat-status').textContent).toBe('Jumped to 0:30.');
    });

    it('shows an error status when the video player is removed before seeking', async () => {
      const { video } = await openEventsTab();

      const eventButton = rail().querySelector('.pagetollm-chat-event > button');
      await act(async () => eventButton.click());
      await flushAsyncWork();

      video.remove();
      await act(async () => eventButton.click());
      await flushAsyncWork();
      expect(rail().querySelector('.pagetollm-chat-status.is-error').textContent).toContain(
        'video player is not available',
      );
    });

    it('switching level re-requests cards at the new level', async () => {
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const level1Btn = Array.from(rail().querySelectorAll('.pagetollm-rail-level-btn')).find(
        (btn) => btn.textContent === 'L1',
      );
      expect(level1Btn).not.toBeUndefined();
      buildYouTubeRailCards.mockClear();
      await act(async () => {
        level1Btn.click();
      });
      expect(buildYouTubeRailCards).toHaveBeenCalledWith(
        expect.objectContaining({ selectedLevel: 1 }),
      );
    });

    it('marks the card matching the current video time as active', async () => {
      const video = mountVideo();
      video.currentTime = 20; // between card a's (0s) and card b's (30s) timestamps
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const cards = rail().querySelectorAll('.pagetollm-yt-rail-card');
      expect(cards[0].className).toContain('is-active');
      expect(cards[1].className).not.toContain('is-active');
    });

    it('clamps to the first card when no video element is present on the page', async () => {
      // getCurrentTime() returns null with no <video>, which normalizes to a
      // non-finite time; findActiveCardIndex clamps that to the first card
      // rather than leaving the rail with nothing highlighted.
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const cards = rail().querySelectorAll('.pagetollm-yt-rail-card');
      expect(cards[0].className).toContain('is-active');
      expect(cards[1].className).not.toContain('is-active');
    });

    it('seeks the video to the clicked card time and best-effort plays it', async () => {
      const video = mountVideo();
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const secondCard = rail().querySelectorAll('.pagetollm-yt-rail-card')[1];
      await act(async () => {
        secondCard.click();
      });
      expect(video.currentTime).toBe(30);
      expect(video.play).toHaveBeenCalled();
    });

    it('reuses the connected video element instead of querying on every read', async () => {
      mountVideo();
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const querySelector = vi.spyOn(document, 'querySelector');
      querySelector.mockClear();

      const secondCard = rail().querySelectorAll('.pagetollm-yt-rail-card')[1];
      await act(async () => {
        secondCard.click();
      });

      expect(querySelector).not.toHaveBeenCalled();
      querySelector.mockRestore();
    });

    it('clamps a negative seek target to 0', async () => {
      const video = mountVideo();
      video.currentTime = 10;
      buildYouTubeRailCards.mockReturnValue([
        {
          id: 'neg',
          name: 'Neg',
          path: 'Neg',
          text: '',
          accent: '#111',
          seconds: -5,
          sentences: [1],
        },
      ]);
      await act(async () => {
        await openYouTubeRail({ key: 'yt-key' });
      });
      const card = rail().querySelector('.pagetollm-yt-rail-card');
      await act(async () => {
        card.click();
      });
      expect(video.currentTime).toBe(0);
      expect(video.play).toHaveBeenCalled();
    });
  });
});
