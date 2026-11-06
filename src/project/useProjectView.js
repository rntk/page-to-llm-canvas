import { useEffect, useState } from 'react';
import { browserScheduler } from '../shared/runtime/browserHosts.js';

export const REFRESH_DEBOUNCE_MS = 150;

const noSubscribe = () => () => {};

/**
 * Loads a project view and keeps it fresh. Change notifications trigger a
 * debounced refetch; only the latest request may update state, so a slow
 * earlier response never overwrites a newer one.
 *
 * @param {object} options
 * @param {string|null} options.projectId
 * @param {{getProjectView: function(string): Promise<object>}} options.api
 * @param {function(function(): void): function(): void} [options.subscribe]
 *   Registers a change callback and returns an unsubscribe.
 * @param {{setTimeout: function, clearTimeout: function}} [options.scheduler]
 * @param {number} [options.debounceMs]
 * @returns {{status: 'idle'|'loading'|'ready'|'error', view: object|null, error: string|null}}
 */
export function useProjectView({
  projectId,
  api,
  subscribe = noSubscribe,
  scheduler = browserScheduler,
  debounceMs = REFRESH_DEBOUNCE_MS,
}) {
  // The state remembers which project it belongs to, so switching ids reads as
  // "loading" without resetting state from inside the effect.
  const [state, setState] = useState({
    projectId: null,
    status: 'loading',
    view: null,
    error: null,
  });

  useEffect(() => {
    if (!projectId) return undefined;
    let active = true;
    let latest = 0;
    let timer = null;

    const load = () => {
      latest += 1;
      const request = latest;
      Promise.resolve()
        .then(() => api.getProjectView(projectId))
        .then(
          (view) => {
            if (active && request === latest) {
              setState({ projectId, status: 'ready', view, error: null });
            }
          },
          (err) => {
            if (active && request === latest) {
              // A failed background refresh keeps the last good view (and the
              // in-memory card layout); only a failed first load is an error.
              setState((prev) =>
                prev.projectId === projectId && prev.status === 'ready'
                  ? prev
                  : {
                      projectId,
                      status: 'error',
                      view: null,
                      error: (err && err.message) || String(err),
                    },
              );
            }
          },
        );
    };

    const scheduleRefresh = () => {
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = scheduler.setTimeout(() => {
        timer = null;
        load();
      }, debounceMs);
    };

    load();
    const unsubscribe = subscribe(scheduleRefresh);
    return () => {
      active = false;
      if (timer !== null) scheduler.clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [projectId, api, subscribe, scheduler, debounceMs]);

  if (!projectId) return { status: 'idle', view: null, error: null };
  if (state.projectId !== projectId) return { status: 'loading', view: null, error: null };
  return { status: state.status, view: state.view, error: state.error };
}
