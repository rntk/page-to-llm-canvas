import { describe, expect, it, vi } from 'vitest';
import { getPageIdentity, observePageNavigation } from './pageNavigation.js';

function createHarness(initialHref, { withNavigation = true } = {}) {
  const contentDocument = new EventTarget();
  const contentWindow = new EventTarget();
  contentWindow.location = { href: initialHref };
  if (withNavigation) contentWindow.navigation = new EventTarget();
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
  it('reports a successfully committed pushState-style SPA navigation', () => {
    const harness = createHarness('https://example.com/one');

    harness.contentWindow.navigation.dispatchEvent(new Event('navigate'));
    expect(harness.onPageChange).not.toHaveBeenCalled();

    harness.contentWindow.location.href = 'https://example.com/two';
    harness.contentWindow.navigation.dispatchEvent(new Event('navigatesuccess'));
    expect(harness.onPageChange).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('does not close or desynchronize after a proposed navigation is canceled', () => {
    const harness = createHarness('https://example.com/one');

    const proposedNavigation = new Event('navigate', { cancelable: true });
    proposedNavigation.preventDefault();
    harness.contentWindow.navigation.dispatchEvent(proposedNavigation);
    expect(harness.contentWindow.location.href).toBe('https://example.com/one');
    expect(harness.onPageChange).not.toHaveBeenCalled();

    // A later real navigation to the formerly canceled destination must still
    // be observed; a speculative identity update would incorrectly suppress it.
    harness.contentWindow.location.href = 'https://example.com/two';
    harness.contentWindow.navigation.dispatchEvent(new Event('navigatesuccess'));
    expect(harness.onPageChange).toHaveBeenCalledTimes(1);
    harness.stop();
  });

  it('ignores a successfully committed same-page hash change', () => {
    const harness = createHarness('https://example.com/article');

    harness.contentWindow.location.href = 'https://example.com/article#section';
    harness.contentWindow.navigation.dispatchEvent(new Event('navigatesuccess'));

    expect(harness.onPageChange).not.toHaveBeenCalled();
    harness.stop();
  });

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

  it('reports back/forward navigation when the Navigation API is unavailable', () => {
    const harness = createHarness('https://example.com/one', { withNavigation: false });
    harness.contentWindow.location.href = 'https://example.com/two';
    harness.contentWindow.dispatchEvent(new Event('popstate'));
    expect(harness.onPageChange).toHaveBeenCalledTimes(1);

    harness.stop();
  });

  it('removes Navigation API, YouTube, and popstate listeners on cleanup', () => {
    const harness = createHarness('https://example.com/one');

    harness.stop();
    harness.contentWindow.location.href = 'https://example.com/two';
    harness.contentWindow.navigation.dispatchEvent(new Event('navigatesuccess'));
    harness.contentWindow.dispatchEvent(new Event('popstate'));
    harness.contentDocument.dispatchEvent(new Event('yt-navigate-finish'));

    expect(harness.onPageChange).not.toHaveBeenCalled();
  });
});
