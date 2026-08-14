import { useEffect, useState } from 'react';
import { MSG } from '../../shared/runtime/messages.js';

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
 * @returns {{ record: object | null, error: string | null }}
 */
export function useRecord(key, source) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(() => (key ? null : 'missing record key'));

  const [prevKey, setPrevKey] = useState(key);
  if (key !== prevKey) {
    setPrevKey(key);
    setRecord(null);
    setError(key ? null : 'missing record key');
  }

  useEffect(() => {
    if (!key) return undefined;

    let cancelled = false;
    const metaKey = `pagetollm:rec:${key}:meta`;
    const contentKey = `pagetollm:rec:${key}:content`;
    const summariesKey = `pagetollm:rec:${key}:summaries`;
    const docKeys = [metaKey, contentKey, summariesKey];

    const fetchViaServiceWorker = async () => {
      const resp = await source.runtimeMessenger.send({ type: MSG.getRecord, key });
      return resp && resp.ok && resp.record ? resp.record : null;
    };

    // 1) initial load via SW, falling back to a direct (one-off) multi-doc
    // read in case the SW hasn't registered a message listener yet.
    fetchViaServiceWorker()
      .then((rec) => {
        if (cancelled) return;
        if (rec) {
          setRecord(rec);
          setError(null);
          return;
        }
        return source.store.get(docKeys).then((items) => {
          if (cancelled) return;
          const merged = {
            ...(items[contentKey] || {}),
            ...(items[summariesKey] || {}),
            ...(items[metaKey] || {}),
          };
          if (items[contentKey] || items[summariesKey] || items[metaKey]) {
            setRecord(merged);
            setError(null);
          } else {
            setError('record not found');
          }
        });
      })
      .catch((e) => {
        if (!cancelled) setError(String(e && e.message ? e.message : e));
      });

    // 2) live updates: any change to this record's docs re-fetches the full,
    // freshly-reassembled record through the same SW path used for the
    // initial load, instead of trying to merge partial doc changes locally.
    const onChanged = () => {
      fetchViaServiceWorker()
        .then((rec) => {
          if (cancelled) return;
          if (rec) {
            setRecord(rec);
            setError(null);
          } else {
            setRecord(null);
            setError('record deleted');
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e && e.message ? e.message : e));
        });
    };
    const unsubscribe = source.store.subscribeChanges(docKeys, onChanged);

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // Depend on the capability members, not the wrapper object: the members
    // stay stable when a caller builds `source` inline per render, which would
    // otherwise resubscribe and refetch on every render. The optional chaining
    // keeps the missing-key path (which returns above, before touching
    // `source`) working without one, as it did before the capability existed.
  }, [key, source?.runtimeMessenger, source?.store]);

  return { record, error };
}
