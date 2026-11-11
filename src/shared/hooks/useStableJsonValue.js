import { useMemo } from 'react';

/**
 * Preserve identity for equivalent immutable, JSON-compatible storage values.
 * The returned snapshot changes whenever its serialized content changes.
 * @param {*} value Storage value to project.
 * @returns {*} Stable JSON snapshot.
 */
export function useStableJsonValue(value) {
  const json = useMemo(() => JSON.stringify(value), [value]);
  return useMemo(() => (json === undefined ? undefined : JSON.parse(json)), [json]);
}
