import { useEffect, useState } from "react";

/**
 * Subscribes to the record stored at `pagetollm:rec:${key}`.
 * Initial fetch goes through the service worker (getRecord message),
 * then we listen to chrome.storage.onChanged for live updates.
 *
 * @param {string} key - The unique storage key for the record.
 * @returns {{ record: object | null, error: string | null }}
 */
export function useRecord(key) {
  const [record, setRecord] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!key) {
      setError("missing record key");
      return undefined;
    }

    let cancelled = false;
    const storageKey = `pagetollm:rec:${key}`;

    // 1) initial load via SW
    try {
      chrome.runtime.sendMessage({ type: "getRecord", key }, (resp) => {
        if (cancelled) return;
        if (chrome.runtime.lastError) {
          setError(String(chrome.runtime.lastError.message || "runtime error"));
          return;
        }
        if (resp && resp.ok && resp.record) {
          setRecord(resp.record);
          setError(null);
        } else {
          // Fallback: read directly from storage in case SW hasn't registered yet.
          chrome.storage.local.get(storageKey, (items) => {
            if (cancelled) return;
            const rec = items && items[storageKey];
            if (rec) {
              setRecord(rec);
              setError(null);
            } else {
              setError("record not found");
            }
          });
        }
      });
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
    }

    // 2) live updates
    const onChanged = (changes, areaName) => {
      if (areaName !== "local") return;
      const change = changes[storageKey];
      if (!change) return;
      if (change.newValue) {
        setRecord(change.newValue);
        setError(null);
      } else if (change.oldValue) {
        // Record was deleted from storage.
        setRecord(null);
        setError("record deleted");
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch (_) {
      /* noop */
    }

    return () => {
      cancelled = true;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch (_) {
        /* noop */
      }
    };
  }, [key]);

  return { record, error };
}
