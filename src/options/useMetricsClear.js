import { useCallback, useState } from 'react';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

/**
 * Drives the "clear metrics" flow shared by metrics sections that route the
 * clear through a worker message (so it serializes with worker-side writes)
 * and surface a recoverable error on failure: send the clear message, throw
 * if it wasn't acknowledged, and on any failure reload the stored metrics so
 * the user sees current data and isn't left in a permanently busy state.
 *
 * Only fits sections that (a) clear via `sendRuntimeMessage` and (b) render a
 * `clearError` message. Sections with a simpler catch (no error message, no
 * dedicated reload-failure handling) don't reuse this hook.
 *
 * @param {{
 *   messageType: string,
 *   defaultErrorMessage: string,
 *   empty: function(): *,
 *   read: function(): Promise<*>,
 *   setMetrics: function(*): void,
 * }} options
 * @returns {{ isClearing: boolean, clearError: string, handleClear: function(): Promise<void> }}
 */
export function useMetricsClear({ messageType, defaultErrorMessage, empty, read, setMetrics }) {
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState('');

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    setClearError('');
    try {
      const response = await sendRuntimeMessage({ type: messageType });
      if (!response?.ok) {
        throw new Error(response?.error || defaultErrorMessage);
      }
      setMetrics(empty());
    } catch (error) {
      // A failed clear leaves the stored counters intact. Reload them so the
      // user can see the current data and try again instead of being left in
      // a permanently busy state.
      let message = error?.message || defaultErrorMessage;
      try {
        const stored = await read();
        setMetrics(stored);
      } catch (reloadError) {
        message += `. Metrics could not be reloaded: ${reloadError?.message || String(reloadError)}`;
      }
      setClearError(message);
    } finally {
      setIsClearing(false);
    }
  }, [messageType, defaultErrorMessage, empty, read, setMetrics]);

  return { isClearing, clearError, handleClear };
}
