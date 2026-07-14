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
    Element.prototype.scrollTo = vi.fn(function scrollTo(options) {
      if (typeof options?.top === 'number') this.scrollTop = options.top;
    });
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

  it('places chat History and New controls in the rail header', () => {
    const { container, unmount } = render(
      createElement(YouTubeRail, { ...defaultProps, mode: 'chat', recordKey: 'record-1' }),
    );

    const railHead = container.querySelector('.pagetollm-rail-head');
    expect(railHead.querySelector('.pagetollm-chat-actions')).not.toBeNull();
    expect(railHead.textContent).toContain('History');
    expect(railHead.textContent).toContain('New');
    expect(container.querySelector('.pagetollm-chat-header')).toBeNull();

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

  it('scrolls the active card inside the rail body instead of the page', () => {
    let currentTime = 0;
    const getCurrentTime = vi.fn(() => currentTime);
    const { container, unmount } = render(
      createElement(YouTubeRail, { ...defaultProps, getCurrentTime }),
    );

    const body = container.querySelector('.pagetollm-yt-rail-body');
    const railCards = container.querySelectorAll('.pagetollm-yt-rail-card');
    const scrollTo = vi.spyOn(body, 'scrollTo');
    Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(body, 'scrollHeight', { value: 800, configurable: true });
    body.getBoundingClientRect = () => ({ top: 0, height: 200 });
    railCards[1].getBoundingClientRect = () => ({ top: 420, height: 80 });

    currentTime = 45;
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 360, behavior: 'smooth' });
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();

    unmount();
  });

  it('keeps wheel scrolling inside the rail body', () => {
    const pageWheel = vi.fn();
    document.body.addEventListener('wheel', pageWheel);
    const { container, unmount } = render(createElement(YouTubeRail, defaultProps));

    const body = container.querySelector('.pagetollm-yt-rail-body');
    Object.defineProperty(body, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(body, 'scrollHeight', { value: 500, configurable: true });
    body.scrollTop = 50;

    act(() => {
      body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }));
    });

    expect(body.scrollTop).toBe(110);
    expect(pageWheel).not.toHaveBeenCalled();

    document.body.removeEventListener('wheel', pageWheel);
    unmount();
  });

  it('cleans up interval poll timer when unmounted', () => {
    const getCurrentTime = vi.fn(() => 0);
    const { unmount } = render(createElement(YouTubeRail, { ...defaultProps, getCurrentTime }));

    // Initial render might call getCurrentTime, clear mocks
    getCurrentTime.mockClear();

    // Advance timer and verify it ticks/polls
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getCurrentTime).toHaveBeenCalled();

    getCurrentTime.mockClear();

    // Unmount the component
    unmount();

    // Advance timer again and verify it is NOT called
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(getCurrentTime).not.toHaveBeenCalled();
  });

  it('cleans up scheduled animation frames when unmounted', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(createElement(YouTubeRail, defaultProps));

    unmount();
    expect(cancelSpy).toHaveBeenCalledWith(1);
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
