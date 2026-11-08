import { useCallback } from 'react';
import { useAsyncResource } from '../shared/useAsyncResource.js';

/**
 * Resolves where one tab's chat lives (its saved record or a URL page key).
 * Re-resolves when the tab navigates; only the latest request may update state.
 *
 * @param {object} options
 * @param {number} options.tabId
 * @param {string} options.url Re-resolve trigger: the tab's current URL.
 * @param {function(number): Promise<{source: object}>} options.loadSource
 * @returns {{status: 'loading'|'ready'|'error', source: object|null, error: string|null, reload: function(): void}}
 */
export function usePageChatSource({ tabId, url, loadSource }) {
  const load = useCallback(async () => (await loadSource(tabId)).source, [loadSource, tabId]);
  const { status, data, error, reload } = useAsyncResource(`${tabId}\u0000${url}`, load);
  return { status, source: data, error, reload };
}
