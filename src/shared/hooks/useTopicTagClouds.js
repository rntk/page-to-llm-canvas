import { useEffect, useState } from 'react';
import {
  isTopicTagCloudCacheable,
  readSavedTopicTagClouds,
  topicTagCloudRevision,
} from '../runtime/topicTagClouds.js';

export default function useTopicTagClouds(recordSource, recordKey, source, record, enabled) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState(null);
  const revision = enabled ? topicTagCloudRevision(record, source) : null;
  const saved = revision && readSavedTopicTagClouds(record, source, revision);
  // Compare unversioned summary trees by contents so polling reuses the result.
  const legacyTree =
    revision && !isTopicTagCloudCacheable(source, revision) ? record.summary_tree : null;
  const requestKey =
    enabled && !saved ? JSON.stringify([recordKey, source, revision, legacyTree, attempt]) : null;

  useEffect(() => {
    if (!requestKey || result?.requestKey === requestKey) return undefined;
    let active = true;

    async function load() {
      try {
        const { byPath } = await recordSource.getTopicTagClouds(recordKey, source);
        if (active) setResult({ requestKey, byPath });
      } catch (error) {
        if (active) setResult({ requestKey, error: error?.message || String(error) });
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [recordSource, recordKey, source, requestKey, result]);

  const current = result?.requestKey === requestKey ? result : null;
  return {
    byPath: saved?.byPath ?? current?.byPath,
    error: current?.error,
    loading: requestKey !== null && !current,
    retry: () => setAttempt((previous) => previous + 1),
  };
}
