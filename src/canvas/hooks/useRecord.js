import { useEffect, useState } from 'react';

// Pipeline metadata (e.g. the processing log) can change several times a second;
// debounce so a burst collapses into one full-record read.
export const RECORD_REFRESH_DEBOUNCE_MS = 300;

/**
 * Subscribes to the record identified by `key`. The record is split across
 * independently updated storage documents, so a change payload is never the full
 * record. The initial fetch and every live update go through the service worker's
 * view-record message, which reassembles it; the storage listener is only a refetch trigger.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {{fetch: Function, subscribe: Function}} source
 * @returns {{ record: object | null, error: string | null, isDeleted: boolean }}
 */
export function useRecord(key, source) {
  const fetchRecord = source?.fetch;
  const subscribeToRecord = source?.subscribe;
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(() => (key ? null : 'missing record key'));
  const [isDeleted, setIsDeleted] = useState(false);

  // A missing capability is a wiring bug, but must not throw and tear down the
  // modal: report it as an unusable record. Derived in render, not set in the effect.
  const sourceUnavailable =
    typeof fetchRecord !== 'function' || typeof subscribeToRecord !== 'function';

  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setRecord(null);
    setError(key ? null : 'missing record key');
    setIsDeleted(false);
  }

  useEffect(() => {
    if (!key || sourceUnavailable) return undefined;

    let cancelled = false;
    let refreshTimer = null;
    // Bumped on every storage change so a stale request can't overwrite a newer record.
    let recordRevision = 0;
    const fetchViaServiceWorker = async () => {
      const resp = await fetchRecord(key);
      if (resp?.ok === false && (resp.code === 'not_found' || resp.error === 'record not found'))
        return null;
      if (resp?.ok === false && typeof resp.error === 'string') {
        throw new Error(resp.error);
      }
      if (resp?.pipelineFailure?.message) {
        throw new Error(resp.pipelineFailure.message);
      }
      return resp?.ok === true && resp.record ? resp.record : null;
    };

    // Messaging wakes a cold MV3 worker, whose listener waits for storage bootstrap.
    const initialRevision = recordRevision;
    fetchViaServiceWorker()
      .then((rec) => {
        if (cancelled || initialRevision !== recordRevision) return;
        if (rec) {
          setRecord(rec);
          setError(null);
          setIsDeleted(false);
          return;
        }
        setError('record not found');
        setIsDeleted(true);
      })
      .catch((e) => {
        if (!cancelled && initialRevision === recordRevision) {
          setError(String(e && e.message ? e.message : e));
        }
      });

    // Live updates: any change to the record's docs refetches the full record
    // instead of merging partial doc changes locally.
    const refreshRecord = () => {
      refreshTimer = null;
      const refreshRevision = recordRevision;
      fetchViaServiceWorker()
        .then((rec) => {
          if (cancelled || refreshRevision !== recordRevision) return;
          if (rec) {
            setRecord(rec);
            setError(null);
            setIsDeleted(false);
          } else {
            setRecord(null);
            setError('record deleted');
            setIsDeleted(true);
          }
        })
        .catch((e) => {
          if (!cancelled && refreshRevision === recordRevision) {
            setError(String(e && e.message ? e.message : e));
          }
        });
    };
    const onChanged = () => {
      recordRevision += 1;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshRecord, RECORD_REFRESH_DEBOUNCE_MS);
    };
    const unsubscribe = subscribeToRecord(key, onChanged);

    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      unsubscribe();
    };
    // Depend on the members, not `source`: an inline `source` would otherwise
    // resubscribe and refetch every render.
  }, [key, sourceUnavailable, fetchRecord, subscribeToRecord]);

  // The missing-key error is more specific, so it takes priority.
  return {
    record,
    error: key && sourceUnavailable ? 'record source unavailable' : error,
    isDeleted,
  };
}
