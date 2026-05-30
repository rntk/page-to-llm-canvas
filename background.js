import {
  readRecord,
  writeRecord,
  updateRecord,
  listRecords,
  deleteRecord,
  deleteAll,
  findRecordByUrl,
} from './worker/storage.js';
import { runPipeline } from './worker/orchestrator.js';
import { callLLMDirect } from './worker/llm.js';
import {
  getProvidersState,
  sanitizeProvider,
  sanitizeProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
} from './worker/providers.js';

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

function isExtensionPageSender(sender) {
  const extensionRoot =
    typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!sender?.url && !!extensionRoot && sender.url.startsWith(extensionRoot);
}

function sendSafeProviderState(sendResponse, state, extra = {}) {
  sendResponse({ ok: true, ...extra, ...sanitizeProvidersState(state) });
}

// Record statuses that mean a pipeline is (or should be) actively running.
const IN_FLIGHT_STATUSES = new Set(['pending', 'splitting', 'summarizing']);

// Alarm name used to keep the service worker alive while pipelines are running.
const KEEPALIVE_ALARM = 'pipeline-keepalive';
// Chrome MV3 enforces a minimum of 30 s (0.5 min) for alarm periods.
const KEEPALIVE_PERIOD_MINUTES = 0.5;

function scheduleKeepAlive() {
  chrome.alarms.get(KEEPALIVE_ALARM, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    }
  });
}

function clearKeepAliveIfIdle() {
  if (_jobRegistry.size === 0 && _starting.size === 0) {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // Resume any in-flight records that lost their SW context (e.g. after SW termination).
  listRecords().then((items) => {
    const inFlight = items.filter((r) => IN_FLIGHT_STATUSES.has(r.status));
    if (inFlight.length === 0) {
      chrome.alarms.clear(KEEPALIVE_ALARM);
      return;
    }
    for (const rec of inFlight) {
      startPipeline(rec.key).catch((err) => {
        console.error('PageToLLM Canvas keepalive resume failed for', rec.key, err);
      });
    }
  });
});

/**
 * In-memory job registry to prevent duplicate pipeline runs while the
 * service worker is alive. Keyed by record key; value is the run promise.
 * @type {Map<string, Promise<void>>}
 */
const _jobRegistry = new Map();
const _starting = new Set();

/** Clears the in-memory job registry. Exposed for testing only. */
export function _resetJobRegistry() {
  _jobRegistry.clear();
  _starting.clear();
}

/**
 * @param {object} rec
 * @returns {boolean}
 */
function isStaleRecord(rec) {
  if (!rec) return false;
  if (!IN_FLIGHT_STATUSES.has(rec.status)) return false;
  const age = Date.now() - (rec.updatedAt || 0);
  return age > STALE_THRESHOLD_MS;
}

/**
 * @param {string} s
 * @returns {Promise<string>}
 */
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Starts the pipeline for a key if it is not already running.
 * Resumes stale or orphaned in-flight records (e.g. after a SW restart).
 * If a job is already in the registry but the record is stale (updatedAt older
 * than STALE_THRESHOLD_MS), the hung promise is evicted and the job is restarted.
 *
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function startPipeline(key) {
  if (_starting.has(key)) return;

  _starting.add(key);
  try {
    const rec = await readRecord(key);
    if (!rec) return;

    if (!IN_FLIGHT_STATUSES.has(rec.status)) return;

    // Skip if a healthy (non-stale) job is already in the registry.
    if (_jobRegistry.has(key) && !isStaleRecord(rec)) return;

    // Evict any hung/stale promise before starting fresh.
    _jobRegistry.delete(key);

    scheduleKeepAlive();

    const promise = runPipeline(key)
      .catch((err) => {
        console.error('PageToLLM Canvas background pipeline failed for', key, err);
      })
      .finally(() => {
        _jobRegistry.delete(key);
        clearKeepAliveIfIdle();
      });

    _jobRegistry.set(key, promise);
    return promise;
  } finally {
    _starting.delete(key);
  }
}

/**
 * @param {{html?: string, sourceUrl?: string}} submission
 * @returns {Promise<{ok: boolean, key?: string, error?: string}>}
 */
export async function handleSubmit({ html, sourceUrl, selectors }) {
  if (!html) return { ok: false, error: 'missing html' };

  let existing = null;
  if (sourceUrl) {
    existing = await findRecordByUrl(sourceUrl);
  }

  let key;
  if (existing) {
    key = existing.key;
  } else {
    const hex = await sha256Hex(html);
    key = hex.slice(0, 32);
    existing = await readRecord(key);
  }

  if (existing && existing.status === 'done') {
    return { ok: true, key };
  }

  // If a job is already running (or starting) for this key, do not clobber it.
  if (_jobRegistry.has(key) || _starting.has(key)) {
    return { ok: true, key };
  }

  const now = Date.now();
  const rec = existing || {
    key,
    sourceUrl: sourceUrl || '',
    html,
    text: '',
    status: 'pending',
    error: null,
    progress: { stage: 'queued', done: 0, total: 0 },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    selectors: Array.isArray(selectors) ? selectors : [],
    createdAt: now,
    updatedAt: now,
  };
  if (existing) {
    rec.status = 'pending';
    rec.error = null;
    rec.progress = { stage: 'queued', done: 0, total: 0 };
    rec.updatedAt = now;
    rec.sourceUrl = sourceUrl || rec.sourceUrl;
    rec.html = html;
    rec.processingLog = [];
    if (Array.isArray(selectors)) rec.selectors = selectors;
  }
  await writeRecord(rec);

  // Start the pipeline in the background; do not await.
  startPipeline(key).catch((err) => {
    console.error('PageToLLM Canvas background startPipeline failed:', err);
  });

  return { ok: true, key };
}

/**
 * @param {{prompt?: string, temperature?: number, model?: string}} request
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
async function handleLLMRequest({ prompt, temperature = 0.8, model }) {
  if (!prompt) return { ok: false, error: 'missing prompt' };
  return callLLMDirect({ prompt, temperature, model });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'no type' });
    return false;
  }

  (async () => {
    try {
      switch (msg.type) {
        case 'submit': {
          const r = await handleSubmit(msg);
          sendResponse(r);
          return;
        }
        case 'ensurePipeline': {
          const { key } = msg;
          if (!key) {
            sendResponse({ ok: false, error: 'missing key' });
            return;
          }
          await startPipeline(key);
          sendResponse({ ok: true });
          return;
        }
        case 'retryRecord': {
          const { key } = msg;
          if (!key) {
            sendResponse({ ok: false, error: 'missing key' });
            return;
          }
          const updated = await updateRecord(key, {
            status: 'pending',
            error: null,
            progress: { stage: 'queued', done: 0, total: 0 },
          });
          if (!updated) {
            sendResponse({ ok: false, error: 'record not found' });
            return;
          }
          startPipeline(key).catch((err) => {
            console.error('PageToLLM Canvas retryRecord startPipeline failed:', err);
          });
          sendResponse({ ok: true });
          return;
        }
        case 'reprocessRecord': {
          const { key } = msg;
          if (!key) {
            sendResponse({ ok: false, error: 'missing key' });
            return;
          }
          const rec = await readRecord(key);
          if (!rec) {
            sendResponse({ ok: false, error: 'record not found' });
            return;
          }
          await updateRecord(key, {
            status: 'pending',
            error: null,
            progress: { stage: 'queued', done: 0, total: 0 },
            topics: [],
            topic_summaries: {},
            topic_summary_index: {},
            sentences: [],
            text: '',
            processingLog: [],
          });
          startPipeline(key).catch((err) => {
            console.error('PageToLLM Canvas reprocessRecord startPipeline failed:', err);
          });
          sendResponse({ ok: true });
          return;
        }
        case 'getRecord': {
          const rec = await readRecord(msg.key);
          if (rec) sendResponse({ ok: true, record: rec });
          else sendResponse({ ok: false });
          return;
        }
        case 'listRecords': {
          const items = await listRecords();
          sendResponse({ ok: true, items });
          return;
        }
        case 'deleteRecord': {
          await deleteRecord(msg.key);
          sendResponse({ ok: true });
          return;
        }
        case 'deleteAll': {
          await deleteAll();
          sendResponse({ ok: true });
          return;
        }
        case 'llmChatCompletion': {
          const r = await handleLLMRequest(msg);
          sendResponse(r);
          return;
        }
        case 'listProviders': {
          if (!isExtensionPageSender(sender)) {
            sendResponse({
              ok: false,
              error: 'provider settings are only available to extension pages',
            });
            return;
          }
          const state = await getProvidersState();
          sendSafeProviderState(sendResponse, state);
          return;
        }
        case 'saveProvider': {
          if (!isExtensionPageSender(sender)) {
            sendResponse({
              ok: false,
              error: 'provider settings are only available to extension pages',
            });
            return;
          }
          const provider = await saveProvider(msg.provider);
          const state = await getProvidersState();
          sendSafeProviderState(sendResponse, state, { provider: sanitizeProvider(provider) });
          return;
        }
        case 'deleteProvider': {
          if (!isExtensionPageSender(sender)) {
            sendResponse({
              ok: false,
              error: 'provider settings are only available to extension pages',
            });
            return;
          }
          if (!msg.id) {
            sendResponse({ ok: false, error: 'missing id' });
            return;
          }
          const state = await deleteProvider(msg.id);
          sendSafeProviderState(sendResponse, state);
          return;
        }
        case 'setActiveProvider': {
          if (!isExtensionPageSender(sender)) {
            sendResponse({
              ok: false,
              error: 'provider settings are only available to extension pages',
            });
            return;
          }
          if (!msg.id) {
            sendResponse({ ok: false, error: 'missing id' });
            return;
          }
          const state = await setActiveProvider(msg.id);
          sendSafeProviderState(sendResponse, state);
          return;
        }
        default:
          sendResponse({ ok: false, error: 'unknown type: ' + msg.type });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.message) || String(e) });
    }
  })();

  return true;
});
