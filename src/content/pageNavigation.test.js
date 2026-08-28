import { describe, expect, it, vi } from 'vitest';
import { getPageIdentity, observePageNavigation } from './pageNavigation.js';

function createHarness(initialHref) {
  const contentDocument = new EventTarget();
  const contentWindow = new EventTarget();
  contentWindow.location = { href: initialHref };
  const onPageChange = vi.fn();
  const stop = observePageNavigation({
    document: contentDocument,
    window: contentWindow,
    onPageChange,
  });
  return { contentDocument, contentWindow, onPageChange, stop };
}

describe('getPageIdentity', () => {
  it('uses the video id for YouTube video pages', () => {
    expect(getPageIdentity('https://www.youtube.com/watch?v=video-a&t=30s')).toBe(
      'youtube-video:video-a',
    );
    expect(getPageIdentity('https://www.youtube.com/shorts/video-a')).toBe('youtube-video:video-a');
  });

  it('ignores hashes on ordinary pages', () => {
    expect(getPageIdentity('https://example.com/article#section')).toBe(
      'https://example.com/article',
    );
  });
});

describe('observePageNavigation', () => {
  it('reports a YouTube SPA navigation to a different video', () => {
    const harness = createHarness('https://www.youtube.com/watch?v=video-a');
    harness.contentWindow.location.href = 'https://www.youtube.com/watch?v=video-b';

    harness.contentDocument.dispatchEvent(new Event('yt-navigate-finish'));

    expect(harness.onPageChange).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('keeps the surface open for timestamp, playlist, and hash changes on the same video', () => {
    const harness = createHarness('https://www.youtube.com/watch?v=video-a');
    harness.contentWindow.location.href =
      'https://www.youtube.com/watch?v=video-a&t=90s&list=playlist#details';

    harness.contentDocument.dispatchEvent(new Event('yt-navigate-finish'));

    expect(harness.onPageChange).not.toHaveBeenCalled();
    harness.stop();
  });

  it('reports back/forward navigation and removes both listeners on cleanup', () => {
    const harness = createHarness('https://example.com/one');
    harness.contentWindow.location.href = 'https://example.com/two';
    harness.contentWindow.dispatchEvent(new Event('popstate'));
    expect(harness.onPageChange).toHaveBeenCalledTimes(1);

    harness.stop();
    harness.contentWindow.location.href = 'https://example.com/three';
    harness.contentWindow.dispatchEvent(new Event('popstate'));
    harness.contentDocument.dispatchEvent(new Event('yt-navigate-finish'));

    expect(harness.onPageChange).toHaveBeenCalledTimes(1);
  });
});
