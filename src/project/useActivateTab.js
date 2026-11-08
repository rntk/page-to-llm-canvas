import { useState } from 'react';

/**
 * Activates tabs and exposes a user-facing error when switching fails.
 * @param {{activateTab: function(number): Promise<void>}} tabsHost
 * @returns {{go: function(number): Promise<void>, error: string, clearError: function(): void}}
 */
export function useActivateTab(tabsHost) {
  const [error, setError] = useState('');
  const clearError = () => setError('');
  const go = (tabId) => {
    clearError();
    return Promise.resolve()
      .then(() => tabsHost.activateTab(tabId))
      .catch(() => setError('Could not switch to tab'));
  };

  return { go, error, clearError };
}
