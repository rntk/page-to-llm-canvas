import { useCallback, useEffect, useState } from 'react';

/**
 * Resolves where one tab's chat lives (its saved record or a URL page key).
 * Re-resolves when the tab navigates; only the latest request may update state.
 *
 * @param {object} options
 * @param {string} options.projectId
 * @param {number} options.tabId
 * @param {string} options.url Re-resolve trigger: the tab's current URL.
 * @param {{getPageChat: function(string, number): Promise<{source: object}>}} options.api
 * @returns {{status: 'loading'|'ready'|'error', source: object|null, error: string|null, reload: function(): void}}
 */
export function usePageChatSource({ projectId, tabId, url, api }) {
  const [attempt, setAttempt] = useState(0);
  // Tagged with its request so a navigation reads as loading without resetting
  // state from inside the effect.
  const [state, setState] = useState({ request: null, source: null, error: null });
  const request = `${projectId}\u0000${tabId}\u0000${url}\u0000${attempt}`;

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => api.getPageChat(projectId, tabId))
      .then(
        (result) => {
          if (active) setState({ request, source: result.source, error: null });
        },
        (err) => {
          if (active) {
            setState({ request, source: null, error: (err && err.message) || String(err) });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [api, projectId, tabId, request]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.request !== request) return { status: 'loading', source: null, error: null, reload };
  if (state.error) return { status: 'error', source: null, error: state.error, reload };
  return { status: 'ready', source: state.source, error: null, reload };
}
