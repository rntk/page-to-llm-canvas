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
import {
  clearLocal,
  getAllLocalKeys,
  getLocal,
  MUTATION_QUEUE_KEY,
  queuedUpdate,
} from './primitives.js';

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

// Values are read in small batches on the estimate path so a large category
// is never resident in the heap all at once.
const APPROXIMATE_BATCH_SIZE = 20;

/**
 * Sums the JSON size of the given keys' values without ever holding more than
 * one batch of them in memory. Only used when `getBytesInUse` is unavailable.
 *
 * A failed batch is skipped rather than aborting the whole overview, but its
 * size is then missing from the sum, so `partial` marks `bytes` as a lower
 * bound. Without that signal a transient read failure would surface as a
 * confidently too-small number, which is the direction that misleads a user
 * deciding whether their stored data is worth deleting.
 * @param {string[]} keys
 * @returns {Promise<{bytes: number, partial: boolean}>}
 */
async function approximateBytes(keys) {
  let total = 0;
  let partial = false;
  for (let start = 0; start < keys.length; start += APPROXIMATE_BATCH_SIZE) {
    const batch = keys.slice(start, start + APPROXIMATE_BATCH_SIZE);
    try {
      const items = await getLocal(batch);
      total += new TextEncoder().encode(JSON.stringify(items)).byteLength;
    } catch (err) {
      partial = true;
      log.warn('size estimate failed for a batch of keys:', err);
    }
  }
  return { bytes: total, partial };
}

/**
 * @param {string[]} keys
 * @returns {Promise<{bytes: number, approximate: boolean, partial: boolean}>}
 *   `approximate` is true when the real byte count could not be obtained
 *   (older Chrome without `getBytesInUse`, or a `lastError` on the call) and
 *   `bytes` is a rough JSON-size estimate instead of the true on-disk figure.
 *   `partial` is true when some values could not be read at all, which makes
 *   `bytes` a lower bound rather than a whole-category estimate.
 */
function bytesInUse(keys) {
  if (!keys.length) return Promise.resolve({ bytes: 0, approximate: false, partial: false });
  const estimate = () =>
    approximateBytes(keys).then(({ bytes, partial }) => ({ bytes, approximate: true, partial }));
  if (typeof chrome.storage.local.getBytesInUse !== 'function') {
    return estimate();
  }
  return new Promise((resolve) => {
    chrome.storage.local.getBytesInUse(keys, (bytes) => {
      if (chrome.runtime.lastError) {
        log.warn(
          'getBytesInUse failed, falling back to an approximate size:',
          chrome.runtime.lastError,
        );
        resolve(estimate());
        return;
      }
      resolve({ bytes: Math.max(0, Number(bytes) || 0), approximate: false, partial: false });
    });
  });
}

/**
 * Returns privacy-safe storage metadata for the Options data-management UI.
 */
export async function getStorageOverview() {
  // Keys only: a full `getLocal(null)` would deserialize every stored page,
  // chat and provider payload into the worker heap just to count them, which
  // is enough to stall or crash the worker for an "unlimitedStorage" profile
  // with hundreds of saved articles. Sizes come from `getBytesInUse`, which
  // needs no values at all.
  const allKeys = await getAllLocalKeys();
  const grouped = {
    pageData: [],
    providers: [],
    settings: [],
    diagnostics: [],
    other: [],
  };
  for (const key of allKeys) {
    grouped[categoryForKey(key)].push(key);
  }

  const categories = {};
  await Promise.all(
    Object.entries(grouped).map(async ([id, keys]) => {
      const { bytes, approximate, partial } = await bytesInUse(keys);
      categories[id] = {
        keyCount: keys.length,
        bytes,
        approximate,
        partial,
      };
    }),
  );

  const pageKeys = grouped.pageData;
  categories.pageData.recordCount = pageKeys.filter((key) => key.endsWith(':meta')).length;
  categories.pageData.chatCount = pageKeys.filter(
    (key) => key.startsWith(CHAT_STORAGE_PREFIX) && !key.endsWith(':index'),
  ).length;
  // The one value this overview reads, and only when it exists: the provider
  // list is a single small record, unlike the page/chat payloads.
  const providerState = grouped.providers.length
    ? (await getLocal(PROVIDERS_KEY))[PROVIDERS_KEY]
    : undefined;
  categories.providers.providerCount = Array.isArray(providerState?.providers)
    ? providerState.providers.length
    : 0;

  return {
    totalBytes: Object.values(categories).reduce((sum, category) => sum + category.bytes, 0),
    totalKeyCount: allKeys.length,
    // True when any category's byte count is an estimate rather than the
    // real on-disk size, so totalBytes above is an estimate too.
    approximate: Object.values(categories).some((category) => category.approximate),
    // True when some values could not be read at all, so totalBytes is a lower
    // bound and not merely imprecise.
    partial: Object.values(categories).some((category) => category.partial),
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
