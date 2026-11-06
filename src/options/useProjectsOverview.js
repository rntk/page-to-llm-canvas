import { useCallback, useEffect, useRef, useState } from 'react';

const EMPTY_OVERVIEW = Object.freeze({ projects: [], ungroupedGroups: [] });

/**
 * Keeps the projects overview synchronized with tab, tab-group and project
 * storage changes through injected capabilities.
 *
 * Change events arrive in bursts, so they are debounced into one refetch. Only
 * the latest request may write state, and a failed refresh keeps the last good
 * overview alongside `loadError`.
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
    let timer = null;
    const unsubscribe = subscribeRef.current?.(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void reload();
      }, debounceMs);
    });
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      clearTimeout(timer);
      unsubscribe?.();
    };
  }, [reload, debounceMs]);

  return { overview, isLoading, loadError, reload };
}
