import { browserScheduler } from './browserHosts.js';

/**
 * Coalesces subscription bursts into a trailing callback. Cleanup unsubscribes,
 * cancels pending work and ignores notifications from the disposed subscription.
 * Callers own the subscription's scope and when to recreate it.
 * @param {object} options
 * @param {function(Function, object=): Function} [options.subscribe]
 * @param {Function} options.onChange
 * @param {number} options.debounceMs
 * @param {{setTimeout: Function, clearTimeout: Function}} [options.scheduler]
 * @param {object} [options.subscriptionOptions] Passed through to subscribe.
 * @returns {function(): void} Cleanup.
 */
export function subscribeDebounced({
  subscribe,
  onChange,
  debounceMs,
  scheduler = browserScheduler,
  subscriptionOptions,
}) {
  let active = true;
  let timer = null;
  const notify = () => {
    if (!active) return;
    if (timer !== null) scheduler.clearTimeout(timer);
    timer = scheduler.setTimeout(() => {
      timer = null;
      if (active) void onChange();
    }, debounceMs);
  };
  const unsubscribe = subscribe?.(notify, subscriptionOptions);

  return () => {
    if (!active) return;
    active = false;
    if (timer !== null) scheduler.clearTimeout(timer);
    if (typeof unsubscribe === 'function') unsubscribe();
  };
}
