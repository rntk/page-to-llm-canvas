import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeDebounced } from '../shared/runtime/subscribeDebounced.js';

const EMPTY_OVERVIEW = Object.freeze({ projects: [], ungroupedGroups: [] });

/**
 * Keeps the projects overview synchronized with tab, tab-group and project
 * storage changes through injected capabilities.
 *
 * Change events arrive in bursts, so they are debounced into one refetch. Only
 * the latest request may write state, and a failed refresh keeps the last good
 * overview alongside `loadError`.
 * Capabilities are captured on mount; remount to replace them. Changing
 * `debounceMs` restarts the subscription and fetches with those capabilities.
 *
 * @param {{
 *   listOverview: function(): Promise<{projects: object[], ungroupedGroups: object[]}>,
 *   subscribe: function(function(): void): (function(): void),
 *   debounceMs?: number,
 * }} options Overview dependencies.
 * @returns {{
 *   overview: {projects: object[], ungroupedGroups: object[]},
 *   isLoading: boolean,
 *   loadError: string,
 *   reload: function(): Promise<void>,
 * }}
 */
export function useProjectsOverview({ listOverview, subscribe, debounceMs = 200 }) {
  const [overview, setOverview] = useState(EMPTY_OVERVIEW);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const requestIdRef = useRef(0);
  const mountedRef = useRef(false);
  // Captured on mount so callers passing fresh closures every render do not
  // resubscribe or refetch; remount the owner to change capabilities.
  const listOverviewRef = useRef(listOverview);
  const subscribeRef = useRef(subscribe);

  // Keep this awaitable loader separate from useAsyncResource: overview exposes
  // refresh errors alongside retained data, and reload resolves after the fetch.
  const reload = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    try {
      const result = await listOverviewRef.current();
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setOverview({
        projects: Array.isArray(result?.projects) ? result.projects : [],
        ungroupedGroups: Array.isArray(result?.ungroupedGroups) ? result.ungroupedGroups : [],
      });
      setLoadError('');
    } catch (caughtError) {
      if (!mountedRef.current || requestId !== requestIdRef.current) return;
      setLoadError(caughtError?.message || 'Failed to load projects');
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reload();
    const cleanupSubscription = subscribeDebounced({
      subscribe: subscribeRef.current,
      onChange: reload,
      debounceMs,
    });
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      cleanupSubscription();
    };
  }, [reload, debounceMs]);

  return { overview, isLoading, loadError, reload };
}
