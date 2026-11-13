// User-configurable LLM provider storage for the PageToLLM Canvas extension.
//
// Providers are persisted in chrome.storage.local with a single "active
// provider" selection — the pipeline calls the LLM with no model, so it needs
// one provider designated as the one to use.

import {
  PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
  PROVIDER_MAX_CONTEXT_WINDOW_TOKENS,
} from '../settings/llmBudgets.js';
import { getLocal, queuedUpdate, setLocal } from '../storage/primitives.js';
import { normalizeProviderTemperatures } from './temperatures.js';

/**
 * Canonical provider type strings.
 * @readonly
 */
export const ProviderType = Object.freeze({
  OPENAI: 'openai',
  DEEPSEEK: 'deepseek',
  ANTHROPIC: 'anthropic',
  OPENROUTER: 'openrouter',
  OPENAI_COMP: 'openai_comp',
  LLAMA_DECISION: 'llama_decision',
});

export const PROVIDER_TYPES = Object.freeze(Object.values(ProviderType));

export const ServiceTier = Object.freeze({
  AUTO: 'auto',
  DEFAULT: 'default',
  FLEX: 'flex',
  PRIORITY: 'priority',
});

export const SERVICE_TIER_DEFINITIONS = Object.freeze({
  [ProviderType.OPENAI]: Object.freeze([
    { value: ServiceTier.FLEX, label: 'Flex' },
    { value: ServiceTier.PRIORITY, label: 'Priority' },
    { value: ServiceTier.DEFAULT, label: 'Default' },
    { value: ServiceTier.AUTO, label: 'Auto' },
  ]),
  [ProviderType.ANTHROPIC]: Object.freeze([
    { value: ServiceTier.PRIORITY, label: 'Priority when available' },
    { value: ServiceTier.DEFAULT, label: 'Standard only' },
  ]),
  [ProviderType.OPENROUTER]: Object.freeze([
    { value: ServiceTier.FLEX, label: 'Flex' },
    { value: ServiceTier.PRIORITY, label: 'Priority' },
  ]),
});

/**
 * Default model suggestions per provider type, used to seed the options-page
 * dropdowns.
 * `capability` is 'completion' (generated text) or 'decision' (structured answers only).
 * @type {ReadonlyArray<{type: string, displayName: string, models: string[], defaultModel: string, requiresUrl: boolean, capability: 'completion'|'decision'}>}
 */
export const PROVIDER_DEFINITIONS = Object.freeze([
  {
    type: ProviderType.OPENAI,
    displayName: 'OpenAI',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano'],
    defaultModel: 'gpt-5.4-nano',
    requiresUrl: false,
    capability: 'completion',
  },
  {
    type: ProviderType.DEEPSEEK,
    displayName: 'DeepSeek',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
    requiresUrl: false,
    capability: 'completion',
  },
  {
    type: ProviderType.ANTHROPIC,
    displayName: 'Anthropic',
    models: ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
    defaultModel: 'claude-haiku-5-5',
    requiresUrl: false,
    capability: 'completion',
  },
  {
    type: ProviderType.OPENROUTER,
    displayName: 'OpenRouter',
    models: [
      'openai/gpt-4o-mini',
      'openai/gpt-4o',
      'anthropic/claude-3.5-haiku',
      'anthropic/claude-sonnet-4-5',
      'google/gemini-2.0-flash-001',
      'meta-llama/llama-3.3-70b-instruct',
    ],
    defaultModel: 'openai/gpt-4o-mini',
    requiresUrl: false,
    capability: 'completion',
  },
  {
    type: ProviderType.LLAMA_DECISION,
    displayName: 'llama.cpp Decision API',
    models: [],
    defaultModel: '',
    requiresUrl: true,
    capability: 'decision',
  },
  {
    type: ProviderType.OPENAI_COMP,
    displayName: 'OpenAI-compatible (custom URL)',
    models: [],
    defaultModel: '',
    requiresUrl: true,
    capability: 'completion',
  },
]);

/** @param {string} type */
export function getProviderDefinition(type) {
  return PROVIDER_DEFINITIONS.find((definition) => definition.type === type) || null;
}

/**
 * Whether a provider can serve generated-text requests.
 * @param {ProviderEntry} provider
 * @returns {boolean}
 */
export function isCompletionProvider(provider) {
  return getProviderDefinition(provider.type)?.capability === 'completion';
}

/**
 * Whether a provider only answers structured decision requests.
 * @param {ProviderEntry} provider
 * @returns {boolean}
 */
export function isDecisionProvider(provider) {
  return getProviderDefinition(provider.type)?.capability === 'decision';
}

/**
 * Validates a decision server base URL. Shared by save-time normalization and
 * the DecisionClient constructor so a saved provider cannot fail at run time.
 * @param {string} url
 * @param {boolean} hasToken Whether a bearer token will be sent.
 * @returns {URL}
 */
export function validateDecisionUrl(url, hasToken) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error(`Decision base URL is not a valid URL: ${url}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
    throw new Error('Decision base URL must be an HTTP(S) URL without query or fragment');
  }
  if (
    hasToken &&
    parsed.protocol !== 'https:' &&
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) {
    throw new Error('An API token requires an HTTPS base URL (plain HTTP only for localhost)');
  }
  return parsed;
}

/** Storage key holding the full provider state ({ providers, activeId, splitterId, pageScanId }). */
export const PROVIDERS_KEY = 'pagetollm:llm:providers';

/**
 * @typedef {Object} ProviderEntry
 * @property {string} id          Stable unique id.
 * @property {string} name        Human-readable label.
 * @property {string} type        One of ProviderType.
 * @property {string} model       Model identifier sent to the provider.
 * @property {string} token       API key / bearer token (may be empty for local).
 * @property {string} [url]       Base URL — required for custom and decision providers.
 * @property {string} [serviceTier] Optional provider service tier.
 * @property {number} [contextWindowTokens] Optional model context window.
 * @property {{summaries?: number, chat?: number, splitting?: number}} [temperatures] Optional
 *   per-task sampling temperatures. A task with no value omits the
 *   `temperature` parameter from that task's requests.
 */

/**
 * @typedef {Object} ProvidersState
 * @property {ProviderEntry[]} providers
 * @property {string|null} activeId
 * @property {string|null} splitterId Decision provider placing topic boundaries;
 *   null lets the completion LLM split topics.
 * @property {string|null} pageScanId Decision provider scanning each project page
 *   for relevance before the project chat answers; null lets the completion LLM scan.
 */

/**
 * Reads the raw provider state, tolerating missing/corrupt data.
 * @returns {Promise<ProvidersState>}
 */
export async function getProvidersState() {
  return (await readProvidersDocument()).state;
}

/**
 * Reads the stored document. `state` is the normalized view the public getters
 * expose; `unrecognized` holds well-formed entries of a type this build does
 * not know (for example from a newer version) so mutators can write them back
 * untouched instead of destroying them and their tokens.
 * @returns {Promise<{state: ProvidersState, unrecognized: object[]}>}
 */
async function readProvidersDocument() {
  const items = await getLocal(PROVIDERS_KEY);
  const raw = items[PROVIDERS_KEY];
  const stored = Array.isArray(raw?.providers) ? raw.providers : [];
  const unrecognized = stored.filter(
    (entry) => !isValidStored(entry) && entry && typeof entry.id === 'string',
  );
  const providers = Array.isArray(raw?.providers) ? raw.providers.filter(isValidStored) : [];
  let activeId = typeof raw?.activeId === 'string' ? raw.activeId : null;
  const activeProvider = providers.find((p) => p.id === activeId);
  if (!activeProvider) {
    activeId = null;
  } else if (!isCompletionProvider(activeProvider)) {
    activeId = providers.find(isCompletionProvider)?.id ?? null;
  }
  const splitterId = typeof raw?.splitterId === 'string' ? raw.splitterId : null;
  const pageScanId = typeof raw?.pageScanId === 'string' ? raw.pageScanId : null;
  return { state: { providers, activeId, splitterId, pageScanId }, unrecognized };
}

/**
 * Removes stored secret material before returning provider data to UI callers.
 * @param {ProviderEntry} provider
 */
export function sanitizeProvider(provider) {
  const { token, ...safeProvider } = provider;
  return { ...safeProvider, hasToken: !!token };
}

/**
 * @param {ProvidersState} state
 * @returns {{providers: Array<{id: string, name: string, type: string, model: string, url: string, serviceTier: string, contextWindowTokens: number, hasToken: boolean}>, activeId: string|null, splitterId: string|null, pageScanId: string|null}}
 */
export function sanitizeProvidersState(state) {
  return {
    providers: state.providers.map(sanitizeProvider),
    activeId: state.activeId,
    splitterId: state.splitterId ?? null,
    pageScanId: state.pageScanId ?? null,
  };
}

function isValidStored(entry) {
  return (
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.type === 'string' &&
    PROVIDER_TYPES.includes(entry.type)
  );
}

/**
 * Persists the normalized state plus the unrecognized entries read with it.
 * @param {ProvidersState} state
 * @param {Awaited<ReturnType<typeof readProvidersDocument>>} document
 */
async function writeProvidersState(state, document) {
  await setLocal({
    [PROVIDERS_KEY]: { ...state, providers: [...state.providers, ...document.unrecognized] },
  });
}

/** @returns {Promise<ProviderEntry[]>} */
export async function listProviders() {
  return (await getProvidersState()).providers;
}

/**
 * Validates and normalizes an entry coming from the UI.
 * @param {Partial<ProviderEntry>} input
 * @returns {ProviderEntry}
 */
export function normalizeProvider(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Provider must be an object');
  }
  const type = String(input.type || '').trim();
  if (!PROVIDER_TYPES.includes(type)) {
    throw new Error(`Provider type must be one of: ${PROVIDER_TYPES.join(', ')}`);
  }
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Provider name is required');
  const isDecision = isDecisionProvider({ type });
  const model = String(input.model || '').trim();
  if (!model && !isDecision) throw new Error('Provider model is required');

  const url = String(input.url || '').trim();
  const token = String(input.token || '').trim();
  if (type === ProviderType.OPENAI_COMP && !url) {
    throw new Error('A base URL is required for OpenAI-compatible providers');
  }
  if (isDecision) {
    if (!url) throw new Error('A base URL is required for decision providers');
    validateDecisionUrl(url, !!token);
  }

  const serviceTier = normalizeServiceTier(type, input.serviceTier);
  const contextWindowTokens = normalizeContextWindowTokens(input.contextWindowTokens);
  const temperatures = isDecision ? undefined : normalizeProviderTemperatures(input.temperatures);
  const id = String(input.id || '').trim() || generateId();

  return {
    id,
    name,
    type,
    model,
    token,
    url: url || undefined,
    serviceTier,
    contextWindowTokens,
    temperatures,
  };
}

function normalizeContextWindowTokens(value) {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < PIPELINE_MIN_CONTEXT_WINDOW_TOKENS ||
    parsed > PROVIDER_MAX_CONTEXT_WINDOW_TOKENS
  ) {
    throw new Error(
      `Context window (tokens) must be an integer between ${PIPELINE_MIN_CONTEXT_WINDOW_TOKENS} and ${PROVIDER_MAX_CONTEXT_WINDOW_TOKENS}`,
    );
  }
  return parsed;
}

function normalizeServiceTier(type, value) {
  const tier = String(value || '').trim();
  if (!tier) return undefined;
  const allowed = SERVICE_TIER_DEFINITIONS[type] || [];
  if (!allowed.some((oneTier) => oneTier.value === tier)) {
    throw new Error(`Service tier is not supported for provider type: ${type}`);
  }
  return tier;
}

function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `prov_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Creates or updates a provider. The first completion provider added becomes active.
 * @param {Partial<ProviderEntry>} input
 * @returns {Promise<ProviderEntry>}
 */
export async function saveProvider(input) {
  const entry = normalizeProvider(input);
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const document = await readProvidersDocument();
    const { state } = document;
    const existingIndex = state.providers.findIndex((p) => p.id === entry.id);
    const isNew = existingIndex === -1;
    if (isNew) {
      state.providers.push(entry);
    } else {
      const existing = state.providers[existingIndex];
      const customUrlChanged =
        getProviderDefinition(entry.type)?.requiresUrl &&
        (existing.url || '') !== (entry.url || '');
      if (!entry.token && existing.type === entry.type && !customUrlChanged) {
        entry.token = existing.token || '';
      }
      state.providers[existingIndex] = entry;
    }
    // An entry saved as a non-decision type can no longer be the splitter
    // or the project chat page scanner.
    if (state.splitterId === entry.id && !isDecisionProvider(entry)) state.splitterId = null;
    if (state.pageScanId === entry.id && !isDecisionProvider(entry)) state.pageScanId = null;
    const completionProviders = state.providers.filter(isCompletionProvider);
    if (!completionProviders.some((p) => p.id === state.activeId)) {
      // Only auto-activate the very first completion provider. Otherwise leave
      // activeId null so page text never silently moves to another vendor.
      state.activeId =
        isNew && completionProviders.length === 1 && completionProviders[0].id === entry.id
          ? entry.id
          : null;
    }
    await writeProvidersState(state, document);
    return entry;
  });
}

/**
 * Removes a provider. If it was active, activeId is cleared rather than
 * silently switched to another provider; the user must choose a new one.
 * @param {string} id
 * @returns {Promise<ProvidersState>}
 */
export async function deleteProvider(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const document = await readProvidersDocument();
    const { state } = document;
    state.providers = state.providers.filter((p) => p.id !== id);
    if (state.activeId === id) state.activeId = null;
    if (state.splitterId === id) state.splitterId = null;
    if (state.pageScanId === id) state.pageScanId = null;
    await writeProvidersState(state, document);
    return state;
  });
}

/**
 * @param {string} id
 * @returns {Promise<ProvidersState>}
 */
export async function setActiveProvider(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const document = await readProvidersDocument();
    const { state } = document;
    const provider = state.providers.find((p) => p.id === id);
    if (!provider) {
      throw new Error(`Unknown provider id: ${id}`);
    }
    if (!isCompletionProvider(provider)) {
      throw new Error('Decision providers cannot be active completion providers');
    }
    state.activeId = id;
    await writeProvidersState(state, document);
    return state;
  });
}

/**
 * Returns the active provider entry, or null when none is configured.
 * @returns {Promise<ProviderEntry|null>}
 */
export async function getActiveProvider() {
  const { providers, activeId } = await getProvidersState();
  if (!activeId) return null;
  return providers.find((p) => p.id === activeId) || null;
}

/**
 * Selects the decision provider that places topic boundaries; null lets the
 * completion LLM split topics.
 * @param {string|null} id
 * @returns {Promise<ProvidersState>}
 */
export async function setTopicSplitter(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const document = await readProvidersDocument();
    const { state } = document;
    if (id != null) {
      const provider = state.providers.find((p) => p.id === id);
      if (!provider) {
        throw new Error(`Unknown provider id: ${id}`);
      }
      if (!isDecisionProvider(provider)) {
        throw new Error('Only decision providers can split topics');
      }
    }
    state.splitterId = id ?? null;
    await writeProvidersState(state, document);
    return state;
  });
}

/**
 * Returns the selected topic-splitter decision provider, used alongside the
 * active completion provider, or null when the LLM splits topics.
 * @returns {Promise<ProviderEntry|null>}
 */
export async function getDecisionProvider() {
  const { providers, splitterId } = await getProvidersState();
  const provider = providers.find((p) => p.id === splitterId);
  return provider && isDecisionProvider(provider) ? provider : null;
}

/**
 * Selects the decision provider that scans each project page for relevance
 * before the project chat answers; null lets the completion LLM scan.
 * @param {string|null} id
 * @returns {Promise<ProvidersState>}
 */
export async function setPageScanProvider(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const document = await readProvidersDocument();
    const { state } = document;
    if (id != null) {
      const provider = state.providers.find((p) => p.id === id);
      if (!provider) {
        throw new Error(`Unknown provider id: ${id}`);
      }
      if (!isDecisionProvider(provider)) {
        throw new Error('Only decision providers can scan project pages');
      }
    }
    state.pageScanId = id ?? null;
    await writeProvidersState(state, document);
    return state;
  });
}

/**
 * Returns the selected project chat page-scan decision provider, or null when
 * the completion LLM scans pages.
 * @returns {Promise<ProviderEntry|null>}
 */
export async function getPageScanProvider() {
  const { providers, pageScanId } = await getProvidersState();
  const provider = providers.find((p) => p.id === pageScanId);
  return provider && isDecisionProvider(provider) ? provider : null;
}
