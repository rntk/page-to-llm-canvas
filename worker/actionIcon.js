// Toolbar action icon/badge progress rendering. Runs in the service-worker
// context; owns its own debounce/refresh state so background.js only needs
// to wire storage-change notifications into scheduleActionProgressIconRefresh.

import { listRecords } from './storage/storage.js';
import { isInFlightRecord } from './pipeline/pipelineStatus.js';
import { createLogger } from '../src/shared/runtime/log.js';

const log = createLogger('action icon');

const ACTION_ICON_PATHS = Object.freeze({
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  96: 'icons/icon-96.png',
});
const ACTION_ICON_PROGRESS_COLOR = '#2563eb';
const ACTION_ICON_TRACK_COLOR = 'rgba(15, 23, 42, 0.35)';
const ACTION_ICON_MIN_DETERMINATE_RATIO = 0.08;
const ACTION_ICON_INDETERMINATE_RATIO = 0.22;
const ACTION_ICON_REFRESH_DEBOUNCE_MS = 200;

let _actionIconUpdateId = 0;
let _actionIconRefreshTimer = null;
const _actionIconBitmapCache = new Map();

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

export async function refreshActionProgressIcon() {
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
    log.warn('update failed:', err);
  }
}

export function scheduleActionProgressIconRefresh() {
  if (_actionIconRefreshTimer) clearTimeout(_actionIconRefreshTimer);
  _actionIconRefreshTimer = setTimeout(() => {
    _actionIconRefreshTimer = null;
    void refreshActionProgressIcon();
  }, ACTION_ICON_REFRESH_DEBOUNCE_MS);
}
