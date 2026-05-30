// LLM request configuration.
//
// Endpoint/model are no longer hardcoded — they come from the active provider
// configured on the options page (see worker/providers.js). Only transport-level
// settings live here.

export const LLM_REQUEST_TIMEOUT_MS = 120_000;
