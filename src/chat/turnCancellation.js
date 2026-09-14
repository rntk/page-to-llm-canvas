import { MSG } from '../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

let fallbackTurnSequence = 0;

/**
 * Random suffix for the non-`randomUUID` path. `getRandomValues` is not
 * gated on a secure context (unlike `randomUUID`), so it is available in
 * exactly the realms where the fallback is reached.
 * @returns {string}
 */
function fallbackTurnEntropy() {
  const values = globalThis.crypto?.getRandomValues?.(new Uint32Array(2));
  if (values) return `${values[0].toString(36)}${values[1].toString(36)}`;
  return Math.random().toString(36).slice(2, 10);
}

/**
 * `crypto.randomUUID` is secure-context only, so on an http:// page the
 * fallback below is the only path. Turn IDs key a cancellation registry that
 * is global to the one MV3 service worker, so an ID must be unique across
 * content-script realms, not just within one: each realm starts
 * `fallbackTurnSequence` at zero, so two tabs reaching the same ordinal turn
 * in the same millisecond would otherwise mint the same ID and a stop on one
 * would abort both. The counter keeps within-realm IDs distinct even if the
 * clock does not advance; the random suffix keeps them distinct across realms.
 * @returns {string}
 */
export function createTurnId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  fallbackTurnSequence += 1;
  return `chat-turn-${Date.now()}-${fallbackTurnSequence}-${fallbackTurnEntropy()}`;
}

/**
 * @param {AbortSignal} [signal] Signal the turn is listening to.
 * @returns {Error} The abort reason, normalised to an Error.
 */
export function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('The chat turn was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * @param {AbortSignal} [signal] Signal the turn is listening to.
 */
export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

/**
 * Settle `value`, but reject as soon as the turn is aborted instead of waiting
 * for a provider request that may never come back.
 * @param {Promise|*} value Pending work.
 * @param {AbortSignal} [signal] Signal the turn is listening to.
 * @returns {Promise<*>}
 */
export function awaitWithAbort(value, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Forward a cancellation to the background boundary so in-flight provider work
 * can be aborted there too.
 * @param {{turnId: string}} input Turn to cancel.
 * @returns {Promise<*>}
 */
export function postCancelChatTurn({ turnId }) {
  if (!turnId || !MSG.cancelChatTurn) return Promise.resolve();
  return sendRuntimeMessage({ type: MSG.cancelChatTurn, turnId });
}
