// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import YouTubeRail from './YouTubeRail.jsx';

function render(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    rerender(nextElement) {
      act(() => root.render(nextElement));
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const cards = [
  {
    id: 'intro',
    name: 'Intro',
    path: 'Intro',
    text: 'Opening summary',
    accent: '#a11',
    seconds: 0,
    sentences: [1],
  },
  {
    id: 'middle',
    name: 'Middle',
    path: 'Intro > Middle',
    text: '',
    accent: '#1a1',
    seconds: 30,
    sentences: [2],
  },
];

const defaultProps = {
  mode: 'topics',
  maxLevel: 2,
  selectedLevel: 1,
  cards,
  onSelectMode: vi.fn(),
  onSelectLevel: vi.fn(),
  onClose: vi.fn(),
  getCurrentTime: vi.fn(() => 0),
  onSeek: vi.fn(),
  pollIntervalMs: 1000,
};

describe('YouTubeRail', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('renders rail controls and handles mode, level, close, and seek actions', () => {
    const onSelectMode = vi.fn();
    const onSelectLevel = vi.fn();
    const onClose = vi.fn();
    const onSeek = vi.fn();

    const { container, unmount } = render(
      createElement(YouTubeRail, {
        ...defaultProps,
        onSelectMode,
        onSelectLevel,
        onClose,
        onSeek,
      }),
    );

    const modeSelect = container.querySelector('.pagetollm-rail-mode-select');
    expect(modeSelect.value).toBe('topics');
    act(() => {
      modeSelect.value = 'summaries';
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(onSelectMode).toHaveBeenCalledWith('summaries');

    const levelButtons = container.querySelectorAll('.pagetollm-rail-level-btn');
    expect(levelButtons).toHaveLength(3);
    expect(levelButtons[1].className).toContain('active');
    act(() => levelButtons[2].click());
    expect(onSelectLevel).toHaveBeenCalledWith(2);

    const railCards = container.querySelectorAll('.pagetollm-yt-rail-card');
    expect(railCards).toHaveLength(2);
    expect(railCards[0].textContent).toContain('Intro');
    expect(railCards[1].getAttribute('title')).toContain('0:30');
    act(() => railCards[1].click());
    expect(onSeek).toHaveBeenCalledWith(30);

    act(() => container.querySelector('.pagetollm-rail-close').click());
    expect(onClose).toHaveBeenCalled();

    unmount();
  });

  it('marks the active card from current playback time and updates on polling', () => {
    let currentTime = 0;
    const getCurrentTime = vi.fn(() => currentTime);
    const { container, unmount } = render(
      createElement(YouTubeRail, { ...defaultProps, getCurrentTime }),
    );

    let railCards = container.querySelectorAll('.pagetollm-yt-rail-card');
    expect(railCards[0].className).toContain('is-active');
    expect(railCards[1].className).not.toContain('is-active');

    currentTime = 45;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    railCards = container.querySelectorAll('.pagetollm-yt-rail-card');
    expect(railCards[0].className).not.toContain('is-active');
    expect(railCards[1].className).toContain('is-active');

    unmount();
  });

  it('renders summaries with body fallback and empty state for invalid cards', () => {
    const { container, rerender, unmount } = render(
      createElement(YouTubeRail, { ...defaultProps, mode: 'summaries' }),
    );

    const bodies = container.querySelectorAll('.pagetollm-yt-rail-card-body');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].textContent).toBe('Opening summary');
    expect(bodies[1].textContent).toBe('(no summary)');

    rerender(
      createElement(YouTubeRail, {
        ...defaultProps,
        mode: 'summaries',
        cards: [{ id: '', seconds: Number.NaN }],
      }),
    );

    expect(container.querySelector('.pagetollm-yt-rail-empty').textContent).toContain(
      'No timestamped summaries',
    );

    unmount();
  });
});
