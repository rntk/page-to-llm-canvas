import { useEffect, useState } from 'react';
import { MSG } from '../../shared/runtime/messages.js';

// Pipeline metadata (especially the buffered processing log) can change several
// times per second. Canvas and Hierarchy only need the settled record, so wait
// for a quiet period and collapse a burst into one full-record read.
export const RECORD_REFRESH_DEBOUNCE_MS = 300;

/**
 * Subscribes to the record identified by `key`. The record is physically
 * split across `pagetollm:rec:${key}:meta` / `:content` / `:summaries` docs
 * (see worker/storage/storage.js), so a single storage key's `onChanged` payload is
 * not the full record. Initial fetch and every live update go through the
 * service worker's `getRecord` message, which reassembles the full record
 * from the split docs; the storage listener here is only a refetch trigger,
 * not a source of record data itself.
 *
 * @param {string} key - The unique storage key for the record.
 * @param {{runtimeMessenger: {send: Function}, store: {get: Function, subscribeChanges: Function}}} source
 * @returns {{ record: object | null, error: string | null, isDeleted: boolean }}
 */
export function useRecord(key, source) {
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

    let cancelled = false;
    let refreshTimer = null;
    // Invalidated as soon as storage changes, so an older request cannot land
    // after a newer document revision and overwrite the current record.
    let recordRevision = 0;
    const metaKey = `pagetollm:rec:${key}:meta`;
    const contentKey = `pagetollm:rec:${key}:content`;
    const summariesKey = `pagetollm:rec:${key}:summaries`;
    const docKeys = [metaKey, contentKey, summariesKey];

    const fetchViaServiceWorker = async () => {
      const resp = await source.runtimeMessenger.send({ type: MSG.getRecord, key });
      if (resp?.ok === false && typeof resp.error === 'string') {
        throw new Error(resp.error);
      }
      return resp?.ok === true && resp.record ? resp.record : null;
    };

    // 1) initial load via SW, falling back to a direct (one-off) multi-doc
    // read in case the SW hasn't registered a message listener yet.
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
        return source.store.get(docKeys).then((items) => {
          if (cancelled || initialRevision !== recordRevision) return;
          const merged = {
            ...(items[contentKey] || {}),
            ...(items[summariesKey] || {}),
            ...(items[metaKey] || {}),
          };
          if (items[contentKey] || items[summariesKey] || items[metaKey]) {
            setRecord(merged);
            setError(null);
            setIsDeleted(false);
          } else {
            setError('record not found');
            // The service worker lookup and the authoritative direct-storage
            // fallback both missed. Treat a modal opened or reloaded with this
            // key as stale and let its host remove the orphaned iframe.
            setIsDeleted(true);
          }
        });
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
    const unsubscribe = source.store.subscribeChanges(docKeys, onChanged);

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
  }, [key, source?.runtimeMessenger, source?.store]);

  return { record, error, isDeleted };
}
