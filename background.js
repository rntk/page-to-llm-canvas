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
const ACTION_ICON_PATHS = Object.freeze({
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  96: 'icons/icon-96.png',
});
const RECORD_STORAGE_PREFIX = 'pagetollm:rec:';
const ACTION_ICON_PROGRESS_COLOR = '#2563eb';
const ACTION_ICON_TRACK_COLOR = 'rgba(15, 23, 42, 0.35)';
const ACTION_ICON_MIN_DETERMINATE_RATIO = 0.08;
const ACTION_ICON_INDETERMINATE_RATIO = 0.22;
const ACTION_ICON_REFRESH_DEBOUNCE_MS = 200;

function isExtensionPageSender(sender) {
  const extensionRoot =
    typeof chrome.runtime.getURL === 'function' ? chrome.runtime.getURL('') : '';
  return !!sender?.url && !!extensionRoot && sender.url.startsWith(extensionRoot);
}

// Record statuses that mean a pipeline is (or should be) actively running.
const IN_FLIGHT_STATUSES = new Set(['pending', 'splitting', 'summarizing']);

// Alarm name used to keep the service worker alive while pipelines are running.
const KEEPALIVE_ALARM = 'pipeline-keepalive';
// Chrome MV3 enforces a minimum of 30 s (0.5 min) for alarm periods.
const KEEPALIVE_PERIOD_MINUTES = 0.5;
let _actionIconUpdateId = 0;
let _actionIconRefreshTimer = null;
const _actionIconBitmapCache = new Map();

function isInFlightRecord(record) {
  return !!record && IN_FLIGHT_STATUSES.has(record.status);
}

export function summarizeProcessingState(records) {
  const inFlight = (Array.isArray(records) ? records : []).filter(isInFlightRecord);
  if (inFlight.length === 0) {
    return { active: false, count: 0, ratio: 0 };
  }

  let done = 0;
  let total = 0;
  for (const rec of inFlight) {
    const progress = rec && rec.progress;
    const recDone = Number(progress && progress.done);
    const recTotal = Number(progress && progress.total);
    // Queued records still count for the badge, but only determinate stages
    // with a total contribute to the bar ratio.
    if (Number.isFinite(recDone) && Number.isFinite(recTotal) && recTotal > 0) {
      done += Math.max(0, Math.min(recDone, recTotal));
      total += recTotal;
    }
  }

  const ratio =
    total > 0
      ? Math.max(ACTION_ICON_MIN_DETERMINATE_RATIO, Math.min(done / total, 1))
      : ACTION_ICON_INDETERMINATE_RATIO;

  return { active: true, count: inFlight.length, ratio };
}

function hasActionIconApi() {
  return !!chrome.action && typeof chrome.action.setIcon === 'function';
}

function hasActionBadgeApi() {
  return (
    !!chrome.action &&
    typeof chrome.action.setBadgeText === 'function' &&
    typeof chrome.action.setBadgeBackgroundColor === 'function'
  );
}

function setActionBadge(state) {
  if (!hasActionBadgeApi()) return;
  if (!state.active) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  chrome.action.setBadgeBackgroundColor({ color: ACTION_ICON_PROGRESS_COLOR });
  chrome.action.setBadgeText({ text: state.count > 1 ? String(state.count) : '...' });
}

function resetActionIcon() {
  if (!hasActionIconApi()) return;
  chrome.action.setIcon({ path: ACTION_ICON_PATHS });
}

async function loadIconBitmap(size) {
  if (_actionIconBitmapCache.has(size)) {
    return _actionIconBitmapCache.get(size);
  }

  const url = chrome.runtime.getURL(ACTION_ICON_PATHS[size]);
  const bitmapPromise = fetch(url)
    .then((response) => response.blob())
    .then((blob) => createImageBitmap(blob))
    .catch((err) => {
      _actionIconBitmapCache.delete(size);
      throw err;
    });
  _actionIconBitmapCache.set(size, bitmapPromise);
  return bitmapPromise;
}

async function renderProgressIcon(size, ratio) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const bitmap = await loadIconBitmap(size);
  ctx.drawImage(bitmap, 0, 0, size, size);

  const barHeight = Math.max(3, Math.round(size * 0.18));
  const radius = Math.max(1, Math.round(barHeight / 2));
  const inset = Math.max(1, Math.round(size * 0.08));
  const barWidth = size - inset * 2;
  const y = size - barHeight - inset;
  const fillWidth = Math.max(radius * 2, Math.round(barWidth * ratio));

  ctx.fillStyle = ACTION_ICON_TRACK_COLOR;
  ctx.beginPath();
  ctx.roundRect(inset, y, barWidth, barHeight, radius);
  ctx.fill();

  ctx.fillStyle = ACTION_ICON_PROGRESS_COLOR;
  ctx.beginPath();
  ctx.roundRect(inset, y, Math.min(fillWidth, barWidth), barHeight, radius);
  ctx.fill();

  return ctx.getImageData(0, 0, size, size);
}

async function setActionProgressIcon(state, updateId) {
  setActionBadge(state);
  if (!hasActionIconApi()) return;
  if (!state.active) {
    resetActionIcon();
    return;
  }
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return;

  const imageData = {};
  for (const size of Object.keys(ACTION_ICON_PATHS).map(Number)) {
    const rendered = await renderProgressIcon(size, state.ratio);
    if (!rendered) return;
    imageData[size] = rendered;
  }
  if (updateId !== _actionIconUpdateId) return;
  chrome.action.setIcon({ imageData });
}

async function refreshActionProgressIcon() {
  if (_actionIconRefreshTimer) {
    clearTimeout(_actionIconRefreshTimer);
    _actionIconRefreshTimer = null;
  }
  const updateId = ++_actionIconUpdateId;
  try {
    const records = await listRecords();
    if (updateId !== _actionIconUpdateId) return;
    await setActionProgressIcon(summarizeProcessingState(records), updateId);
  } catch (err) {
    console.warn('PageToLLM Canvas action icon update failed:', err);
  }
}

function scheduleActionProgressIconRefresh() {
  if (_actionIconRefreshTimer) clearTimeout(_actionIconRefreshTimer);
  _actionIconRefreshTimer = setTimeout(() => {
    _actionIconRefreshTimer = null;
    refreshActionProgressIcon();
  }, ACTION_ICON_REFRESH_DEBOUNCE_MS);
}

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

try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (Object.keys(changes).some((key) => key.startsWith(RECORD_STORAGE_PREFIX))) {
      scheduleActionProgressIconRefresh();
    }
  });
} catch (_) {
  /* noop */
}

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
 * @param {{html?: string, sourceUrl?: string, selectors?: string[]}} submission
 * @returns {Promise<{ok: boolean, key?: string, error?: string}>}
 */
export async function handleSubmit(submission) {
  const { html, sourceUrl, selectors } = submission;
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
 * Declarative handler registry.
 *
 * Each entry has:
 *   requiresExtensionPage {boolean}  – when true, sender must be an extension page
 *   validate(msg) {function}         – returns an error string or null
 *   handle(msg, sender) {function}   – async, returns the response fields object
 *
 * @type {Record<string, {
 *   requiresExtensionPage: boolean,
 *   validate: (msg: object) => string | null,
 *   handle: (msg: object, sender: object) => Promise<object>
 * }>}
 */
export const MESSAGE_HANDLERS = {
  submit: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      return handleSubmit(msg);
    },
  },

  ensurePipeline: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      await startPipeline(msg.key);
      return { ok: true };
    },
  },

  retryRecord: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const updated = await updateRecord(msg.key, {
        status: 'pending',
        error: null,
        progress: { stage: 'queued', done: 0, total: 0 },
      });
      if (!updated) {
        return { ok: false, error: 'record not found' };
      }
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas retryRecord startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  reprocessRecord: {
    requiresExtensionPage: false,
    validate(msg) {
      return msg.key ? null : 'missing key';
    },
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (!rec) {
        return { ok: false, error: 'record not found' };
      }
      await updateRecord(msg.key, {
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
      startPipeline(msg.key).catch((err) => {
        console.error('PageToLLM Canvas reprocessRecord startPipeline failed:', err);
      });
      return { ok: true };
    },
  },

  getRecord: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const rec = await readRecord(msg.key);
      if (rec) return { ok: true, record: rec };
      return { ok: false };
    },
  },

  listRecords: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      const items = await listRecords();
      return { ok: true, items };
    },
  },

  deleteRecord: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      await deleteRecord(msg.key);
      return { ok: true };
    },
  },

  deleteAll: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle() {
      await deleteAll();
      return { ok: true };
    },
  },

  llmChatCompletion: {
    requiresExtensionPage: false,
    validate: () => null,
    async handle(msg) {
      const { prompt, temperature = 0.8, model } = msg;
      if (!prompt) return { ok: false, error: 'missing prompt' };
      return callLLMDirect({ prompt, temperature, model });
    },
  },

  listProviders: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle() {
      const state = await getProvidersState();
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  saveProvider: {
    requiresExtensionPage: true,
    validate: () => null,
    async handle(msg) {
      const provider = await saveProvider(msg.provider);
      const state = await getProvidersState();
      return { ok: true, provider: sanitizeProvider(provider), ...sanitizeProvidersState(state) };
    },
  },

  deleteProvider: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await deleteProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },

  setActiveProvider: {
    requiresExtensionPage: true,
    validate(msg) {
      return msg.id ? null : 'missing id';
    },
    async handle(msg) {
      const state = await setActiveProvider(msg.id);
      return { ok: true, ...sanitizeProvidersState(state) };
    },
  },
};

/**
 * Pure dispatch function. Owns: unknown-type handling, extension-page sender
 * gating, per-handler validation, and try/catch wrapping. Always resolves.
 *
 * Precondition: msg is non-null and has a non-empty `type` field.
 * (The `no type` short-circuit is the listener's responsibility so it can
 * return `false` synchronously in that case.)
 *
 * @param {object} msg
 * @param {object} sender
 * @param {typeof MESSAGE_HANDLERS} [handlers]
 * @returns {Promise<object>}
 */
export async function dispatchMessage(msg, sender, handlers = MESSAGE_HANDLERS) {
  const entry = handlers[msg.type];
  if (!entry) {
    return { ok: false, error: 'unknown type: ' + msg.type };
  }

  if (entry.requiresExtensionPage && !isExtensionPageSender(sender)) {
    return { ok: false, error: 'provider settings are only available to extension pages' };
  }

  const validationError = entry.validate(msg);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    return await entry.handle(msg, sender);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) {
    sendResponse({ ok: false, error: 'no type' });
    return false;
  }

  dispatchMessage(msg, sender).then(sendResponse);

  return true;
});

refreshActionProgressIcon();
