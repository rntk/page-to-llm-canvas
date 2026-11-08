import { useCallback, useEffect, useRef } from 'react';
import { useAsyncResource } from '../shared/useAsyncResource.js';
import { browserScheduler } from '../shared/runtime/browserHosts.js';
import { shareEqual } from '../shared/runtime/shareEqual.js';

export const REFRESH_DEBOUNCE_MS = 150;

const noSubscribe = () => () => {};

function reconcileView(previous, view) {
  // Keep unchanged merge branches identical so consumers can memoize on them.
  return previous?.topicMerge && view?.topicMerge
    ? { ...view, topicMerge: shareEqual(previous.topicMerge, view.topicMerge) }
    : view;
}

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
 * @returns {{status: 'idle'|'loading'|'ready'|'error', view: object|null, error: string|null, refresh: Function}}
 */
export function useProjectView({
  projectId,
  api,
  subscribe = noSubscribe,
  scheduler = browserScheduler,
  debounceMs = REFRESH_DEBOUNCE_MS,
}) {
  const load = useCallback(() => api.getProjectView(projectId), [api, projectId]);
  const {
    status,
    data: view,
    error,
    reload: refresh,
  } = useAsyncResource(projectId || null, load, {
    keepPrevious: true,
    reconcile: reconcileView,
  });
  const currentView = useRef(null);
  useEffect(() => {
    currentView.current = view;
  }, [view]);

  useEffect(() => {
    if (!projectId) return undefined;
    let timer = null;

    const scheduleRefresh = () => {
      if (timer !== null) scheduler.clearTimeout(timer);
      timer = scheduler.setTimeout(() => {
        timer = null;
        refresh();
      }, debounceMs);
    };

    const unsubscribe = subscribe(scheduleRefresh, {
      scope: { projectId, getView: () => currentView.current },
    });
    return () => {
      if (timer !== null) scheduler.clearTimeout(timer);
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [projectId, api, subscribe, scheduler, debounceMs, refresh]);

  return { status, view, error, refresh };
}
