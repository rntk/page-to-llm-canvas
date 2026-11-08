import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './runtime/errorMessage.js';

const replace = (_previous, next) => next;

/**
 * Loads a keyed resource. Keys and loaders must be stable between renders;
 * changing either discards the previous scope. Only the latest request wins.
 * @param {unknown} key A null key disables loading.
 * @param {function(): Promise<unknown>} load
 * @param {object} [options]
 * @param {boolean} [options.keepPrevious] Keep settled state during reloads and
 *   retain successful data if a background reload fails.
 * @param {function(unknown, unknown): unknown} [options.reconcile] Reuse parts of
 *   the previous value when accepting a successful response.
 * @returns {{status: string, data: unknown, error: string|null, reload: Function}}
 */
export function useAsyncResource(key, load, { keepPrevious = false, reconcile = replace } = {}) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState(null);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (key === null) return undefined;
    let active = true;
    Promise.resolve()
      .then(() => load())
      .then(
        (data) => {
          if (!active) return;
          setState((previous) => ({
            key,
            load,
            revision,
            status: 'ready',
            data: reconcile(
              previous && previous.key === key && previous.load === load ? previous.data : null,
              data,
            ),
            error: null,
          }));
        },
        (error) => {
          if (!active) return;
          setState((previous) =>
            keepPrevious &&
            previous &&
            previous.key === key &&
            previous.load === load &&
            previous.status === 'ready'
              ? previous
              : { key, load, revision, status: 'error', data: null, error: errorMessage(error) },
          );
        },
      );
    return () => {
      active = false;
    };
  }, [key, load, revision, keepPrevious, reconcile]);

  if (key === null) return { status: 'idle', data: null, error: null, reload };
  if (
    !state ||
    state.key !== key ||
    state.load !== load ||
    (!keepPrevious && state.revision !== revision)
  ) {
    return { status: 'loading', data: null, error: null, reload };
  }
  return { status: state.status, data: state.data, error: state.error, reload };
}
