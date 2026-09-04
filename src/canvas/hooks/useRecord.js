import { useEffect, useState } from 'react';

// Pipeline metadata (especially the buffered processing log) can change several
// times per second. Canvas and Hierarchy only need the settled record, so wait
// for a quiet period and collapse a burst into one full-record read.
export const RECORD_REFRESH_DEBOUNCE_MS = 300;

/**
 * Subscribes to the record identified by `key`. The record is physically
 * split across independently updated record documents
 * (see worker/storage/storage.js), so a single storage key's `onChanged` payload is
 * not the full record. Initial fetch and every live update go through the
 * service worker's view-record message, which reassembles the UI projection
 * from the split docs; the storage listener here is only a refetch trigger,
 * not a source of record data itself.
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

  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setRecord(null);
    setError(key ? null : 'missing record key');
    setIsDeleted(false);
  }

  useEffect(() => {
    if (!key) return undefined;
    // A missing capability is a wiring bug rather than a runtime condition, but
    // it must not throw out of the effect and tear the whole modal down: report
    // it the way any other unusable record is reported.
    if (typeof fetchRecord !== 'function' || typeof subscribeToRecord !== 'function') {
      setError('record source unavailable');
      return undefined;
    }

    let cancelled = false;
    let refreshTimer = null;
    // Invalidated as soon as storage changes, so an older request cannot land
    // after a newer document revision and overwrite the current record.
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

    // Initial and live reads are worker-owned. Runtime messaging wakes a cold
    // MV3 worker, whose listener waits for storage bootstrap before dispatch.
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

    // 2) live updates: any change to this record's docs re-fetches the full,
    // freshly-reassembled record through the same SW path used for the
    // initial load, instead of trying to merge partial doc changes locally.
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
    // Depend on the capability members, not the wrapper object: the members
    // stay stable when a caller builds `source` inline per render, which would
    // otherwise resubscribe and refetch on every render. The optional chaining
    // keeps the missing-key path (which returns above, before touching
    // `source`) working without one, as it did before the capability existed.
  }, [key, fetchRecord, subscribeToRecord]);

  return { record, error, isDeleted };
}
