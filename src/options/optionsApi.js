import { MSG } from '../../messages.js';
import { normalizeProvidersResponse } from './optionsLogic.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';

// Delegates to the shared sendRuntimeMessage helper but keeps the options
// surface's swallow semantics: transport errors (chrome.runtime.lastError)
// resolve to undefined instead of rejecting, deliberately mapping them onto
// the generic falsy-response failure branch every call site already has.
export function sendMessage(message) {
  return sendRuntimeMessage(message).catch(() => undefined);
}

export async function listProviders() {
  const response = await sendMessage({ type: MSG.listProviders });
  return normalizeProvidersResponse(response);
}

export async function listRecords() {
  const response = await sendMessage({ type: MSG.listRecords });
  return (response && response.ok && response.items) || [];
}
