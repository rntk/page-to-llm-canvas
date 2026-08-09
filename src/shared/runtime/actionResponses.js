export const STALE_ACTION_MESSAGE = 'This record has already been handled.';

/** @param {unknown} response @returns {boolean} */
export function isStaleActionResponse(response) {
  return response?.ok === true && response?.stale === true;
}

export class StaleActionError extends Error {
  constructor(message = STALE_ACTION_MESSAGE) {
    super(message);
    this.name = 'StaleActionError';
    this.stale = true;
  }
}

/** @param {unknown} error @returns {boolean} */
export function isStaleActionError(error) {
  return error?.stale === true;
}

/**
 * Treats a stale CAS/status rejection as a handled-but-not-performed action,
 * rather than letting `{ok:true}` masquerade as a successful mutation.
 *
 * @param {unknown} response
 * @param {string} fallbackMessage
 * @returns {object}
 */
export function assertActionResponseSucceeded(response, fallbackMessage) {
  if (isStaleActionResponse(response)) throw new StaleActionError();
  if (response?.ok !== true) throw new Error(response?.error || fallbackMessage);
  return response;
}
