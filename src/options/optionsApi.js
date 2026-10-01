import { MSG } from '../shared/runtime/messages.js';
import { normalizeProvidersResponse } from './optionsLogic.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { applyPipelineFailures } from '../shared/runtime/contracts.js';

// Action calls handle transport failures through their falsy-response error path.
// List calls use request() to distinguish transport failures from empty lists.
export function sendMessage(message) {
  return sendRuntimeMessage(message).catch(() => undefined);
}

// Preserve transport failures separately from worker rejections for list UIs.
async function request(message) {
  try {
    const response = await sendRuntimeMessage(message);
    if (response && response.ok) return { ok: true, response };
    return { ok: false, transportError: false, error: (response && response.error) || null };
  } catch (transportError) {
    return {
      ok: false,
      transportError: true,
      error: (transportError && transportError.message) || String(transportError),
    };
  }
}

export async function listProviders() {
  const result = await request({ type: MSG.listProviders });
  if (!result.ok) {
    return {
      providers: null,
      activeId: null,
      error: result.error,
      transportError: result.transportError,
    };
  }
  const normalized = normalizeProvidersResponse(result.response);
  return { ...normalized, error: null, transportError: false };
}

export async function listRecords() {
  const result = await request({ type: MSG.listRecords });
  if (!result.ok) {
    return { items: null, error: result.error, transportError: result.transportError };
  }
  return {
    items: applyPipelineFailures(result.response.items || [], result.response.pipelineFailures),
    error: null,
    transportError: false,
  };
}
