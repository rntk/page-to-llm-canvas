import { MSG } from '../shared/runtime/messages.js';
import { normalizeProvidersResponse } from './optionsLogic.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { applyPipelineFailures } from '../shared/runtime/pipelineFailures.js';

// Delegates to the shared sendRuntimeMessage helper but keeps the options
// surface's swallow semantics: transport errors (chrome.runtime.lastError)
// resolve to undefined instead of rejecting, deliberately mapping them onto
// the generic falsy-response failure branch every call site already has.
// Action call sites (delete/reprocess/save/...) already render `response.error`
// (or a fallback string) into a visible error banner on any falsy response, so
// this swallow does not silently hide a transport failure there. It is NOT
// used by the list-loading paths below, which need to tell "no records" apart
// from "couldn't ask" - see `request()`.
export function sendMessage(message) {
  return sendRuntimeMessage(message).catch(() => undefined);
}

// Strict request helper for list-loading paths, modelled on chatApi.js's
// request(). Unlike `sendMessage` above, this never collapses a transport
// failure and an explicit `{ok:false}` response into the same falsy value -
// callers need to distinguish "the worker said no" from "we couldn't reach
// the worker" so they can render a retry affordance instead of quietly
// rendering an empty list.
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
