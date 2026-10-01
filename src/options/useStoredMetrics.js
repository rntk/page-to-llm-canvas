import { useCallback, useEffect, useRef, useState } from 'react';
import { createLogger } from '../shared/runtime/log.js';

const log = createLogger('Options');

/**
 * Keep a metrics bundle synchronized with its storage key via injected accessors.
 *
 * @param {{
 *   storageKey: string,
 *   read: function(): Promise<*>,
 *   normalize: function(*): *,
 *   empty: function(): *,
 *   subscribe: function(string, function(*): void): function(): void,
 *   loadErrorMessage?: string,
 * }} options Metrics dependencies. `loadErrorMessage` logs initial read failures.
 * @returns {[*, function(*): void]} Current metrics and a local setter.
 */
export function useStoredMetrics({
  storageKey,
  read,
  normalize,
  empty,
  subscribe,
  loadErrorMessage,
}) {
  const [metrics, setMetrics] = useState(empty);
  const revisionRef = useRef(0);
  const setCurrentMetrics = useCallback((nextMetrics) => {
    revisionRef.current += 1;
    setMetrics(nextMetrics);
  }, []);

  useEffect(() => {
    let current = true;
    const loadRevision = revisionRef.current;

    void Promise.resolve()
      .then(() => read())
      .then((stored) => {
        if (current && revisionRef.current === loadRevision) setMetrics(normalize(stored));
      })
      .catch((err) => {
        if (loadErrorMessage) log.warn(loadErrorMessage, err);
      });

    const unsubscribe = subscribe(storageKey, (newValue) => {
      setCurrentMetrics(normalize(newValue));
    });

    return () => {
      // `current` retires this read; the revision guards against newer values.
      current = false;
      unsubscribe();
    };
  }, [loadErrorMessage, normalize, read, setCurrentMetrics, storageKey, subscribe]);

  return [metrics, setCurrentMetrics];
}
