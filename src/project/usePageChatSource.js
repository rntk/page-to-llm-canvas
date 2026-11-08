import { useCallback, useEffect, useState } from 'react';

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
  const [attempt, setAttempt] = useState(0);
  // Tag results with the loader as well as the tab so a new project scope
  // reads as loading without resetting state from inside the effect.
  const [state, setState] = useState({ request: null, loadSource: null, source: null, error: null });
  const request = `${tabId}\u0000${url}\u0000${attempt}`;

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => loadSource(tabId))
      .then(
        (result) => {
          if (active) setState({ request, loadSource, source: result.source, error: null });
        },
        (err) => {
          if (active) {
            setState({
              request,
              loadSource,
              source: null,
              error: (err && err.message) || String(err),
            });
          }
        },
      );
    return () => {
      active = false;
    };
  }, [loadSource, tabId, request]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  if (state.request !== request || state.loadSource !== loadSource)
    return { status: 'loading', source: null, error: null, reload };
  if (state.error) return { status: 'error', source: null, error: state.error, reload };
  return { status: 'ready', source: state.source, error: null, reload };
}
