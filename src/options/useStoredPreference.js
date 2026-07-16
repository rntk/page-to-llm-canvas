import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Keeps a small preference synchronized with chrome.storage.local.
 *
 * The persistence functions are injected so the hook stays independent of a
 * specific preference and the storage boundary remains easy to test.
 */
export function useStoredPreference({
  storageKey,
  defaultValue,
  readPreference,
  writePreference,
  normalize,
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

    const handleStorageChange = (changes, areaName) => {
      if (!mountedRef.current || areaName !== 'local' || !changes || !changes[storageKey]) {
        return;
      }
      revisionRef.current += 1;
      setValue(normalize(changes[storageKey].newValue));
    };

    let listening = false;
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
      listening = true;
    } catch (_) {
      /* noop */
    }

    return () => {
      mountedRef.current = false;
      revisionRef.current += 1;
      if (!listening) return;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
    };
  }, [normalize, readPreference, storageKey]);

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
