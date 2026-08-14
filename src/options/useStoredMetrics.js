import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a metrics counter bundle synchronized with its `chrome.storage.local`
 * key. Replaces the load + subscribe + normalize effect that every metrics
 * section in the options page used to reimplement.
 *
 * The accessors are injected so the hook stays independent of a specific
 * metrics family and the storage boundary remains easy to test.
 *
 * @param {{
 *   storageKey: string,
 *   read: function(): Promise<*>,
 *   normalize: function(*): *,
 *   empty: function(): *,
 *   subscribe: function(string, function(*): void): function(): void,
 *   loadErrorMessage?: string,
 * }} options Metrics dependencies. When `loadErrorMessage` is given, a failed
 *   initial read is logged with `console.warn`; otherwise it is swallowed and
 *   the empty value stays on screen.
 * @returns {[*, function(*): void]} Current metrics and a local setter (used by
 *   the section's own clear handler).
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
        if (current && revisionRef.current === loadRevision) setMetrics(stored);
      })
      .catch((err) => {
        if (loadErrorMessage) console.warn(loadErrorMessage, err);
      });

    const unsubscribe = subscribe(storageKey, (newValue) => {
      setCurrentMetrics(normalize(newValue));
    });

    return () => {
      // `current` alone retires this effect's in-flight read; the revision only
      // has to arbitrate between the read and newer values arriving while the
      // effect is still live.
      current = false;
      unsubscribe();
    };
  }, [loadErrorMessage, normalize, read, setCurrentMetrics, storageKey, subscribe]);

  return [metrics, setCurrentMetrics];
}
