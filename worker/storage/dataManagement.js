// User-facing inventory and full-reset boundary for chrome.storage.local.
// Values never leave the worker: the options page receives category counts and
// byte totals only, so provider tokens and page/chat content are not exposed.

import { INDEX_KEY, RECORD_STORAGE_PREFIX, disposeProcessingLogs } from './storage.js';
import { PROVIDERS_KEY } from '../llm/providers.js';
import { LLM_METRICS_KEY, LLM_METRICS_EPOCH_KEY } from '../metrics/llm.js';
import { PARSER_METRICS_KEY } from '../metrics/parser.js';
import { RESPLIT_METRICS_KEY } from '../metrics/resplit.js';
import { CHAT_TOOL_METRICS_KEY } from '../metrics/chatTool.js';
import { PREFER_CONTENT_LANGUAGE_KEY } from '../settings/language.js';
import { SUMMARIES_DISABLED_KEY } from '../settings/summary.js';
import { MAX_PARALLEL_LLM_REQUESTS_KEY } from '../settings/llmConcurrency.js';
import { LLM_REQUEST_TIMEOUT_SECONDS_KEY } from '../settings/llmTimeout.js';
import { VERBOSE_LOGS_KEY } from '../../src/shared/runtime/verboseLogSettings.js';
import { createLogger } from '../../src/shared/runtime/log.js';
import { clearLocal, getLocal, MUTATION_QUEUE_KEY, queuedUpdate } from './primitives.js';

const log = createLogger();

const CHAT_STORAGE_PREFIX = 'pagetollm:chats:';
const SETTINGS_KEYS = new Set([
  PREFER_CONTENT_LANGUAGE_KEY,
  SUMMARIES_DISABLED_KEY,
  MAX_PARALLEL_LLM_REQUESTS_KEY,
  LLM_REQUEST_TIMEOUT_SECONDS_KEY,
  VERBOSE_LOGS_KEY,
  'pagetollm-highlight-color',
  'pagetollm-theme',
]);
const DIAGNOSTIC_KEYS = new Set([
  LLM_METRICS_KEY,
  LLM_METRICS_EPOCH_KEY,
  PARSER_METRICS_KEY,
  RESPLIT_METRICS_KEY,
  CHAT_TOOL_METRICS_KEY,
]);

function categoryForKey(key) {
  if (
    key === INDEX_KEY ||
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

/**
 * @param {string[]} keys
 * @param {object} items
 * @returns {Promise<{bytes: number, approximate: boolean}>} `approximate` is
 *   true when the real byte count could not be obtained (older Chrome without
 *   `getBytesInUse`, or a `lastError` on the call) and `bytes` is a rough
 *   JSON-size estimate instead of the true on-disk figure.
 */
function bytesInUse(keys, items) {
  if (!keys.length) return Promise.resolve({ bytes: 0, approximate: false });
  if (typeof chrome.storage.local.getBytesInUse !== 'function') {
    return Promise.resolve({ bytes: approximateBytes(items), approximate: true });
  }
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(keys, (bytes) => {
      if (chrome.runtime.lastError) {
        log.warn(
          'getBytesInUse failed, falling back to an approximate size:',
          chrome.runtime.lastError,
        );
        resolve({ bytes: approximateBytes(items), approximate: true });
        return;
      }
      resolve({ bytes: Math.max(0, Number(bytes) || 0), approximate: false });
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
      const { bytes, approximate } = await bytesInUse(keys, items);
      categories[id] = {
        keyCount: keys.length,
        bytes,
        approximate,
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
    // True when any category's byte count is an estimate rather than the
    // real on-disk size, so totalBytes above is an estimate too.
    approximate: Object.values(categories).some((category) => category.approximate),
    categories,
  };
}

/**
 * Removes every local value, including unrecognized keys. Serialized behind
 * record/chat mutations so an already-queued write cannot survive the reset.
 */
export function clearAllExtensionData() {
  // In-memory buffers are not reachable by clearLocal, so drop them inside the
  // same critical section or a pending flush would re-create a meta document
  // after the reset.
  return queuedUpdate(MUTATION_QUEUE_KEY, async () => {
    await clearLocal();
    disposeProcessingLogs();
  });
}
