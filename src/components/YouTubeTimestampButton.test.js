// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import YouTubeTimestampButton from './YouTubeTimestampButton.jsx';

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

describe('YouTubeTimestampButton', () => {
  it('renders nothing when link is null', () => {
    const { container, unmount } = render(createElement(YouTubeTimestampButton, { link: null }));
    expect(container.querySelector('a')).toBeNull();
    unmount();
  });

  it('renders a deep-link and stops pointer events from bubbling', () => {
    const link = { url: 'https://youtu.be/x?t=90', label: '1:30' };
    const { container, unmount } = render(createElement(YouTubeTimestampButton, { link }));

    const anchor = container.querySelector('a.canvas-youtube-timestamp');
    expect(anchor).not.toBeNull();
    expect(anchor.getAttribute('href')).toBe(link.url);
    expect(anchor.getAttribute('title')).toBe('Open YouTube at 1:30');
    expect(anchor.textContent).toContain('1:30');

    const stopSpy = vi.spyOn(Event.prototype, 'stopPropagation');
    act(() => {
      anchor.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      anchor.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(stopSpy).toHaveBeenCalled();
    stopSpy.mockRestore();

    unmount();
  });
});
