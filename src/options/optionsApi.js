import { MSG } from '../../messages.js';
import { normalizeProvidersResponse } from './optionsLogic.js';

export function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

export async function listProviders() {
  const response = await sendMessage({ type: MSG.listProviders });
  return normalizeProvidersResponse(response);
}

export async function listRecords() {
  const response = await sendMessage({ type: MSG.listRecords });
  return (response && response.ok && response.items) || [];
}
