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
 * @type {ReadonlyArray<{type: string, displayName: string, models: string[], defaultModel: string, requiresUrl: boolean}>}
 */
export const PROVIDER_DEFINITIONS = Object.freeze([
  {
    type: ProviderType.OPENAI,
    displayName: 'OpenAI',
    models: ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano'],
    defaultModel: 'gpt-5.4-nano',
    requiresUrl: false,
  },
  {
    type: ProviderType.DEEPSEEK,
    displayName: 'DeepSeek',
    models: ['deepseek-flash', 'deepseek-v4-pro'],
    defaultModel: 'deepseek-flash',
    requiresUrl: false,
  },
  {
    type: ProviderType.ANTHROPIC,
    displayName: 'Anthropic',
    models: ['claude-haiku-5-5', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-6'],
    defaultModel: 'claude-haiku-5-5',
    requiresUrl: false,
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
  },
  {
    type: ProviderType.LLAMA_DECISION,
    displayName: 'llama.cpp Decision API',
    models: [],
    defaultModel: '',
    requiresUrl: true,
  },
  {
    type: ProviderType.OPENAI_COMP,
    displayName: 'OpenAI-compatible (custom URL)',
    models: [],
    defaultModel: '',
    requiresUrl: true,
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
  return provider.type !== ProviderType.LLAMA_DECISION;
}

/** Storage key holding the full provider state ({ providers, activeId }). */
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
 */

/**
 * Reads the raw provider state, tolerating missing/corrupt data.
 * @returns {Promise<ProvidersState>}
 */
export async function getProvidersState() {
  const items = await getLocal(PROVIDERS_KEY);
  const raw = items[PROVIDERS_KEY];
  const providers = Array.isArray(raw?.providers) ? raw.providers.filter(isValidStored) : [];
  let activeId = typeof raw?.activeId === 'string' ? raw.activeId : null;
  const activeProvider = providers.find((p) => p.id === activeId);
  if (!activeProvider) {
    activeId = null;
  } else if (!isCompletionProvider(activeProvider)) {
    activeId = providers.find(isCompletionProvider)?.id ?? null;
  }
  return { providers, activeId };
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
 * @returns {{providers: Array<{id: string, name: string, type: string, model: string, url: string, serviceTier: string, contextWindowTokens: number, hasToken: boolean}>, activeId: string|null}}
 */
export function sanitizeProvidersState(state) {
  return {
    providers: state.providers.map(sanitizeProvider),
    activeId: state.activeId,
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

async function writeProvidersState(state) {
  await setLocal({ [PROVIDERS_KEY]: state });
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
  const model = String(input.model || '').trim();
  if (!model && type !== ProviderType.LLAMA_DECISION) throw new Error('Provider model is required');

  const url = String(input.url || '').trim();
  if (type === ProviderType.OPENAI_COMP && !url) {
    throw new Error('A base URL is required for OpenAI-compatible providers');
  }
  if (type === ProviderType.LLAMA_DECISION) {
    if (!url) throw new Error('A base URL is required for decision providers');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.search || parsed.hash) {
      throw new Error('Decision base URL must be an HTTP(S) URL without query or fragment');
    }
  }

  const token = String(input.token || '').trim();
  const serviceTier = normalizeServiceTier(type, input.serviceTier);
  const contextWindowTokens = normalizeContextWindowTokens(input.contextWindowTokens);
  const temperatures =
    type === ProviderType.LLAMA_DECISION
      ? undefined
      : normalizeProviderTemperatures(input.temperatures);
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
    const state = await getProvidersState();
    const existingIndex = state.providers.findIndex((p) => p.id === entry.id);
    if (existingIndex === -1) {
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
    if (!state.providers.some((p) => p.id === state.activeId && isCompletionProvider(p))) {
      state.activeId = state.providers.find(isCompletionProvider)?.id ?? null;
    }
    await writeProvidersState(state);
    return entry;
  });
}

/**
 * Removes a provider. If it was active, activeId falls back to the first
 * remaining completion provider (or null).
 * @param {string} id
 * @returns {Promise<ProvidersState>}
 */
export async function deleteProvider(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const state = await getProvidersState();
    state.providers = state.providers.filter((p) => p.id !== id);
    if (state.activeId === id) {
      state.activeId = state.providers.find(isCompletionProvider)?.id ?? null;
    }
    await writeProvidersState(state);
    return state;
  });
}

/**
 * @param {string} id
 * @returns {Promise<ProvidersState>}
 */
export async function setActiveProvider(id) {
  return queuedUpdate(PROVIDERS_KEY, async () => {
    const state = await getProvidersState();
    const provider = state.providers.find((p) => p.id === id);
    if (!provider) {
      throw new Error(`Unknown provider id: ${id}`);
    }
    if (!isCompletionProvider(provider)) {
      throw new Error('Decision providers cannot be active completion providers');
    }
    state.activeId = id;
    await writeProvidersState(state);
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
 * Returns the first saved decision provider, used for topic splitting
 * alongside the active completion provider, or null when none is saved.
 * @returns {Promise<ProviderEntry|null>}
 */
export async function getDecisionProvider() {
  const { providers } = await getProvidersState();
  return providers.find((p) => p.type === ProviderType.LLAMA_DECISION) || null;
}
