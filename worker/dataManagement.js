// User-facing inventory and full-reset boundary for chrome.storage.local.
// Values never leave the worker: the options page receives category counts and
// byte totals only, so provider tokens and page/chat content are not exposed.

import { INDEX_KEY, INDEX_SCHEMA_KEY, RECORD_STORAGE_PREFIX } from './storage.js';
import { PROVIDERS_KEY } from './providers.js';
import { LLM_METRICS_KEY, LLM_METRICS_EPOCH_KEY } from './llmMetrics.js';
import { PARSER_METRICS_KEY } from './parserMetrics.js';
import { CHAT_TOOL_METRICS_KEY } from './chatToolMetrics.js';
import { PREFER_CONTENT_LANGUAGE_KEY } from './languageSettings.js';
import { SUMMARIES_DISABLED_KEY } from './summarySettings.js';
import { VERBOSE_LOGS_KEY } from '../verboseLogSettings.js';
import { clearLocal, getLocal, MUTATION_QUEUE_KEY, queuedUpdate } from './storagePrimitives.js';

const CHAT_STORAGE_PREFIX = 'pagetollm:chats:';
const SETTINGS_KEYS = new Set([
  PREFER_CONTENT_LANGUAGE_KEY,
  SUMMARIES_DISABLED_KEY,
  VERBOSE_LOGS_KEY,
  'pagetollm-highlight-color',
  'pagetollm-theme',
]);
const DIAGNOSTIC_KEYS = new Set([
  LLM_METRICS_KEY,
  LLM_METRICS_EPOCH_KEY,
  PARSER_METRICS_KEY,
  CHAT_TOOL_METRICS_KEY,
]);

function categoryForKey(key) {
  if (
    key === INDEX_KEY ||
    key === INDEX_SCHEMA_KEY ||
    key.startsWith(RECORD_STORAGE_PREFIX) ||
    key.startsWith(CHAT_STORAGE_PREFIX)
  ) {
    return 'pageData';
  }
  if (key === PROVIDERS_KEY) return 'providers';
  if (SETTINGS_KEYS.has(key)) return 'settings';
  if (DIAGNOSTIC_KEYS.has(key)) return 'diagnostics';
  return 'other';
}

function approximateBytes(items) {
  try {
    return new TextEncoder().encode(JSON.stringify(items)).byteLength;
  } catch (_) {
    return 0;
  }
}

function bytesInUse(keys, items) {
  if (!keys.length) return Promise.resolve(0);
  if (typeof chrome.storage.local.getBytesInUse !== 'function') {
    return Promise.resolve(approximateBytes(items));
  }
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(keys, (bytes) => {
      if (chrome.runtime.lastError) {
        resolve(approximateBytes(items));
        return;
      }
      resolve(Math.max(0, Number(bytes) || 0));
    });
  });
}

/**
 * Returns privacy-safe storage metadata for the Options data-management UI.
 */
export async function getStorageOverview() {
  const allItems = await getLocal(null);
  const grouped = {
    pageData: {},
    providers: {},
    settings: {},
    diagnostics: {},
    other: {},
  };
  for (const [key, value] of Object.entries(allItems)) {
    grouped[categoryForKey(key)][key] = value;
  }

  const categories = {};
  await Promise.all(
    Object.entries(grouped).map(async ([id, items]) => {
      const keys = Object.keys(items);
      categories[id] = {
        keyCount: keys.length,
        bytes: await bytesInUse(keys, items),
      };
    }),
  );

  const pageKeys = Object.keys(grouped.pageData);
  categories.pageData.recordCount = pageKeys.filter((key) => key.endsWith(':meta')).length;
  categories.pageData.chatCount = pageKeys.filter(
    (key) => key.startsWith(CHAT_STORAGE_PREFIX) && !key.endsWith(':index'),
  ).length;
  const providerState = grouped.providers[PROVIDERS_KEY];
  categories.providers.providerCount = Array.isArray(providerState?.providers)
    ? providerState.providers.length
    : 0;

  return {
    totalBytes: Object.values(categories).reduce((sum, category) => sum + category.bytes, 0),
    totalKeyCount: Object.keys(allItems).length,
    categories,
  };
}

/**
 * Removes every local value, including unknown/legacy keys. Serialized behind
 * record/chat mutations so an already-queued write cannot survive the reset.
 */
export function clearAllExtensionData() {
  return queuedUpdate(MUTATION_QUEUE_KEY, clearLocal);
}
