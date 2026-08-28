import { getYouTubeVideoId } from '../utils/youtubeTimestamp.js';

/**
 * Collapse URL changes that do not change the content represented by a page.
 * In particular, YouTube updates timestamp and playlist parameters without
 * changing the video that an open transcript rail belongs to.
 *
 * @param {string} href
 * @returns {string}
 */
export function getPageIdentity(href) {
  const videoId = getYouTubeVideoId(href);
  if (videoId) return `youtube-video:${videoId}`;

  try {
    const url = new URL(href);
    url.hash = '';
    return url.href;
  } catch (_) {
    return String(href || '').split('#')[0];
  }
}

/**
 * Observe navigation events that do not replace the content-script document.
 * YouTube emits `yt-navigate-finish` for its pushState-driven navigation;
 * popstate covers browser back/forward navigation as a fallback.
 *
 * @param {object} options
 * @param {Document} options.document
 * @param {Window} options.window
 * @param {() => void} options.onPageChange
 * @returns {() => void}
 */
export function observePageNavigation({
  document: contentDocument = globalThis.document,
  window: contentWindow = globalThis.window,
  onPageChange,
} = {}) {
  let pageIdentity = getPageIdentity(contentWindow.location.href);

  const handleNavigation = () => {
    const nextIdentity = getPageIdentity(contentWindow.location.href);
    if (nextIdentity === pageIdentity) return;
    pageIdentity = nextIdentity;
    onPageChange?.();
  };

  contentDocument.addEventListener('yt-navigate-finish', handleNavigation);
  contentWindow.addEventListener('popstate', handleNavigation);

  return () => {
    contentDocument.removeEventListener('yt-navigate-finish', handleNavigation);
    contentWindow.removeEventListener('popstate', handleNavigation);
  };
}
