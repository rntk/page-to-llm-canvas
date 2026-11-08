import { canonicalPageUrl } from '../core/storage/keys.js';

export const excerptNodeKey = (excerptId) => `excerpt:${excerptId}`;

/**
 * Pairs each excerpt with the first tab showing its page (fragment ignored).
 * @param {object[]} tabs
 * @param {object[]} excerpts
 * @returns {{pageOf: Map<string, object>, byPage: Record<string, string[]>, orphans: string[]}}
 */
export function linkExcerpts(tabs, excerpts) {
  const tabByUrl = new Map();
  for (const tab of tabs) {
    const url = canonicalPageUrl(tab.url);
    if (url && !tabByUrl.has(url)) tabByUrl.set(url, tab);
  }
  const pageOf = new Map();
  const byPage = {};
  const orphans = [];
  for (const excerpt of excerpts) {
    const key = excerptNodeKey(excerpt.id);
    const tab = tabByUrl.get(canonicalPageUrl(excerpt.url));
    if (!tab) {
      orphans.push(key);
      continue;
    }
    pageOf.set(excerpt.id, tab);
    (byPage[tab.id] ||= []).push(key);
  }
  return { pageOf, byPage, orphans };
}
