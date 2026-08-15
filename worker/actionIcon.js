// Toolbar action icon/badge progress rendering. Each controller owns its mutable
// refresh state; the background composition root supplies browser dependencies.

import { isInFlightRecord } from './pipeline/pipelineStatus.js';

export const ACTION_ICON_PATHS = Object.freeze({
  16: 'icons/icon-16.png',
  48: 'icons/icon-48.png',
  96: 'icons/icon-96.png',
});
const ACTION_ICON_PROGRESS_COLOR = '#2563eb';
const ACTION_ICON_TRACK_COLOR = 'rgba(15, 23, 42, 0.35)';
const ACTION_ICON_MIN_DETERMINATE_RATIO = 0.08;
const ACTION_ICON_INDETERMINATE_RATIO = 0.22;
const ACTION_ICON_REFRESH_DEBOUNCE_MS = 200;

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

/**
 * Create an independently owned action-icon refresh controller.
 *
 * @param {object} dependencies
 * @param {function(): Promise<object[]>} dependencies.records
 * @param {object} dependencies.actionApi
 * @param {{paths: Record<number, string>, loadBitmap: function(string): Promise<object>}} dependencies.assets
 * @param {function(number, number): object|null} dependencies.canvasFactory
 * @param {{setTimeout: function(Function, number): *, clearTimeout: function(*): void}} dependencies.scheduler
 * @param {{warn: function(...*): void}} dependencies.logger
 */
export function createActionIconController({
  records,
  actionApi,
  assets,
  canvasFactory,
  scheduler,
  logger,
}) {
  let updateId = 0;
  let refreshTimer = null;
  const bitmapCache = new Map();

  const hasIconApi = () => typeof actionApi?.setIcon === 'function';
  const hasBadgeApi = () =>
    typeof actionApi?.setBadgeText === 'function' &&
    typeof actionApi?.setBadgeBackgroundColor === 'function';

  function setBadge(state) {
    if (!hasBadgeApi()) return;
    if (!state.active) {
      actionApi.setBadgeText({ text: '' });
      return;
    }
    actionApi.setBadgeBackgroundColor({ color: ACTION_ICON_PROGRESS_COLOR });
    actionApi.setBadgeText({ text: state.count > 1 ? String(state.count) : '...' });
  }

  async function loadBitmap(size) {
    if (bitmapCache.has(size)) return bitmapCache.get(size);

    const bitmapPromise = assets.loadBitmap(assets.paths[size]).catch((err) => {
      bitmapCache.delete(size);
      throw err;
    });
    bitmapCache.set(size, bitmapPromise);
    return bitmapPromise;
  }

  async function renderProgressIcon(size, ratio) {
    const canvas = canvasFactory(size, size);
    const ctx = canvas?.getContext('2d');
    if (!ctx) return null;
    const bitmap = await loadBitmap(size);
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

  async function setProgressIcon(state, currentUpdateId) {
    setBadge(state);
    if (!hasIconApi()) return;
    if (!state.active) {
      actionApi.setIcon({ path: assets.paths });
      return;
    }

    const imageData = {};
    for (const size of Object.keys(assets.paths).map(Number)) {
      const rendered = await renderProgressIcon(size, state.ratio);
      if (!rendered) return;
      imageData[size] = rendered;
    }
    if (currentUpdateId !== updateId) return;
    actionApi.setIcon({ imageData });
  }

  async function refresh() {
    if (refreshTimer !== null) {
      scheduler.clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    const currentUpdateId = ++updateId;
    try {
      const currentRecords = await records();
      if (currentUpdateId !== updateId) return;
      await setProgressIcon(summarizeProcessingState(currentRecords), currentUpdateId);
    } catch (err) {
      logger.warn('update failed:', err);
    }
  }

  function schedule() {
    if (refreshTimer !== null) scheduler.clearTimeout(refreshTimer);
    refreshTimer = scheduler.setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, ACTION_ICON_REFRESH_DEBOUNCE_MS);
  }

  function dispose() {
    ++updateId;
    if (refreshTimer !== null) scheduler.clearTimeout(refreshTimer);
    refreshTimer = null;
    bitmapCache.clear();
  }

  return { refresh, schedule, dispose };
}
