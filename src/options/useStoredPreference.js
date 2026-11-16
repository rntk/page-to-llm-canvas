import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a small preference synchronized with chrome.storage.local.
 *
 * Persistence and `subscribe` (`(key, onValue) => unsubscribe`) are injected
 * by the composition root, so the hook stays independent and testable.
 * @param {{storageKey: string, defaultValue: unknown, readPreference: Function, writePreference: Function, normalize: Function, subscribe: Function}} options Preference dependencies.
 */
export function useStoredPreference({
  storageKey,
  defaultValue,
  readPreference,
  writePreference,
  normalize,
  subscribe,
}) {
  const [value, setValue] = useState(defaultValue);
  const mountedRef = useRef(false);
  // Invalidates an older load or rollback when a newer local/storage update
  // has already established the value that should be shown.
  const revisionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const loadRevision = revisionRef.current;

    void Promise.resolve()
      .then(() => readPreference())
      .then((stored) => {
        if (mountedRef.current && revisionRef.current === loadRevision) {
          setValue(normalize(stored));
        }
      })
      .catch(() => {
        // The injected storage readers normally degrade to their defaults.
        // Keep the current/default value if a different reader rejects.
      });

    const unsubscribe = subscribe(storageKey, (newValue) => {
      if (!mountedRef.current) return;
      revisionRef.current += 1;
      setValue(normalize(newValue));
    });

    return () => {
      mountedRef.current = false;
      revisionRef.current += 1;
      unsubscribe();
    };
  }, [normalize, readPreference, storageKey, subscribe]);

  const updateValue = useCallback(
    async (nextValue) => {
      const normalized = normalize(nextValue);
      const updateRevision = revisionRef.current + 1;
      revisionRef.current = updateRevision;
      setValue(normalized);

      try {
        await writePreference(normalized);
      } catch (_) {
        try {
          const stored = await readPreference();
          if (mountedRef.current && revisionRef.current === updateRevision) {
            setValue(normalize(stored));
          }
        } catch (_) {
          if (mountedRef.current && revisionRef.current === updateRevision) {
            setValue(defaultValue);
          }
        }
      }
    },
    [defaultValue, normalize, readPreference, writePreference],
  );

  return [value, updateValue];
}
