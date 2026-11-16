import { canonicalPageUrl } from '../core/storage/keys.js';

// Same rule as the worker's page reader (projectPageChat.js).
const READABLE_URL = /^(?:https?|file):/i;

export const UNREADABLE_PAGE_REASON = 'Chat is not available for this kind of page.';

/**
 * Pages a project chat can use: open tabs plus saved pages (which cover a closed group),
 * deduped by canonical URL. Readable pages are numbered from 1 in URL order, so numbering
 * ignores tab order; the rest are listed as unreadable.
 *
 * @param {object} input
 * @param {Array<{title?: string, url?: string}>} [input.tabs] The project view's tabs.
 * @param {Array<{title?: string, url?: string}>} [input.savedPages] The merge's eligible pages.
 * @returns {{pages: Array<{page: number, title: string, url: string}>,
 *   unreadablePages: Array<{title: string, url: string, reason: string}>}}
 */
export function buildProjectChatPages({ tabs, savedPages } = {}) {
  const byUrl = new Map();
  for (const item of [...(tabs || []), ...(savedPages || [])]) {
    const url = canonicalPageUrl(item?.url);
    if (!url || byUrl.has(url)) continue;
    byUrl.set(url, { title: item.title || url, url });
  }
  const sorted = [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  const pages = [];
  const unreadablePages = [];
  for (const entry of sorted) {
    if (READABLE_URL.test(entry.url)) pages.push({ page: pages.length + 1, ...entry });
    else unreadablePages.push({ ...entry, reason: UNREADABLE_PAGE_REASON });
  }
  return { pages, unreadablePages };
}
