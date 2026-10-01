import { useCallback, useState } from 'react';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

/**
 * Clear metrics through the worker, then reload stored values on failure.
 *
 * @param {{
 *   messageType: string,
 *   defaultErrorMessage: string,
 *   empty: function(): *,
 *   read: function(): Promise<*>,
 *   setMetrics: function(*): void
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
      // A failed clear may leave stored counters intact; reload their current value.
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
