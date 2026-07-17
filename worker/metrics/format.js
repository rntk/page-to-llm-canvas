// Pure display / derived-stat helpers for LLM metrics (options UI only).
//
// Kept separate from llm.js so this module has zero chrome.storage
// dependency and can be reasoned about (and tested) as pure functions.

import { LLM_TASK_TYPE_LABELS, normalizeTaskType } from './llm.js';

/**
 * @param {string} taskType
 * @returns {string}
 */
export function formatTaskTypeLabel(taskType) {
  const key = normalizeTaskType(taskType);
  if (LLM_TASK_TYPE_LABELS[key]) return LLM_TASK_TYPE_LABELS[key];
  // Title-case unknown/custom keys for display.
  return key
    .split(/[_:-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Average duration in ms, or null when there are no samples.
 * Works for overall metrics or a single task-type bucket.
 * @param {{ totalCount?: number, totalDurationMs?: number } | null | undefined} metrics
 * @returns {number | null}
 */
export function averageDurationMs(metrics) {
  if (!metrics || !metrics.totalCount) return null;
  return metrics.totalDurationMs / metrics.totalCount;
}

/**
 * Cache-read percentage across requests that reported cache usage.
 * Cache writes count as misses because they did not reuse an existing prefix.
 * @param {{
 *   totalCacheReadTokens?: number,
 *   totalCacheWriteTokens?: number,
 *   totalCacheMissTokens?: number,
 * } | null | undefined} metrics
 * @returns {number | null}
 */
export function cacheHitRate(metrics) {
  if (!metrics) return null;
  const read = Math.max(0, Number(metrics.totalCacheReadTokens) || 0);
  const write = Math.max(0, Number(metrics.totalCacheWriteTokens) || 0);
  const miss = Math.max(0, Number(metrics.totalCacheMissTokens) || 0);
  const total = read + write + miss;
  return total > 0 ? read / total : null;
}

/** @param {number | null | undefined} value
 * @returns {string} */
export function formatMetricCount(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/** @param {number | null | undefined} value
 * @returns {string} */
export function formatMetricPercent(value) {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Task-type keys present in metrics, ordered by totalCount desc then name.
 * @param {{ byTaskType?: Record<string, { totalCount?: number }> }} metrics
 * @returns {string[]}
 */
export function listTaskTypes(metrics) {
  const byTaskType = metrics?.byTaskType || {};
  return Object.keys(byTaskType).sort((a, b) => {
    const countDiff = (byTaskType[b]?.totalCount || 0) - (byTaskType[a]?.totalCount || 0);
    if (countDiff !== 0) return countDiff;
    return a.localeCompare(b);
  });
}

/**
 * @param {number | null | undefined} ms
 * @returns {string}
 */
export function formatDurationMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds - minutes * 60;
  return `${minutes}m ${rem.toFixed(0)}s`;
}
