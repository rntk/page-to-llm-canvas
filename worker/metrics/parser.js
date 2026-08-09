// Privacy-safe topic parser quality metrics. Never stores prompts, responses,
// article text, URLs, record keys, or topic labels.

import { createMetricsStore } from './metricsStore.js';

export const PARSER_METRICS_KEY = 'pagetollm-parser-metrics';
export const PARSER_METRICS_MAX_RECENT = 60;

const QUIRK_KEYS = [
  'invalidRangeTokens',
  'outOfRangeRanges',
  'duplicateSentences',
  'missingSentences',
  'reversedRanges',
  'ignoredLines',
];

export function emptyParserMetrics() {
  return {
    totalCount: 0,
    successCount: 0,
    failureCount: 0,
    repairedCount: 0,
    retryRecoveredCount: 0,
    totals: Object.fromEntries(QUIRK_KEYS.map((key) => [key, 0])),
    recent: [],
  };
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

export function summarizeParserDiagnostics(diagnostics = {}) {
  return {
    invalidRangeTokens: nonNegative(diagnostics.invalidRangeTokens),
    outOfRangeRanges: Array.isArray(diagnostics.outOfRange)
      ? diagnostics.outOfRange.length
      : nonNegative(diagnostics.outOfRangeRanges),
    duplicateSentences: Array.isArray(diagnostics.duplicates)
      ? diagnostics.duplicates.length
      : nonNegative(diagnostics.duplicateSentences),
    missingSentences: Array.isArray(diagnostics.missing)
      ? diagnostics.missing.length
      : nonNegative(diagnostics.missingSentences),
    reversedRanges: nonNegative(diagnostics.reversedRanges),
    ignoredLines: nonNegative(diagnostics.ignoredLineCount ?? diagnostics.ignoredLines),
  };
}

export function normalizeParserMetrics(value) {
  const empty = emptyParserMetrics();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const totals = {};
  for (const key of QUIRK_KEYS) totals[key] = nonNegative(value.totals?.[key]);
  const recent = Array.isArray(value.recent)
    ? value.recent.slice(0, PARSER_METRICS_MAX_RECENT).map((entry) => ({
        at: nonNegative(entry?.at),
        ok: entry?.ok === true,
        repaired: entry?.repaired === true,
        recoveredAfterRetry: entry?.recoveredAfterRetry === true,
        scope: entry?.scope === 'resplit' ? 'resplit' : 'primary',
        attempt: Math.max(1, nonNegative(entry?.attempt)),
        sentenceCount: nonNegative(entry?.sentenceCount),
        inputLineCount: nonNegative(entry?.inputLineCount),
        parsedRangeCount: nonNegative(entry?.parsedRangeCount),
        error: typeof entry?.error === 'string' ? entry.error.slice(0, 160) : '',
        quirks: summarizeParserDiagnostics(entry?.quirks),
      }))
    : [];
  return {
    totalCount: nonNegative(value.totalCount),
    successCount: nonNegative(value.successCount),
    failureCount: nonNegative(value.failureCount),
    repairedCount: nonNegative(value.repairedCount),
    retryRecoveredCount: nonNegative(value.retryRecoveredCount),
    totals,
    recent,
  };
}

const store = createMetricsStore({
  key: PARSER_METRICS_KEY,
  normalize: normalizeParserMetrics,
  empty: emptyParserMetrics,
  label: 'parser',
});

export async function getParserMetrics() {
  return store.getMetrics();
}

export function recordParserMetric(sample = {}) {
  return store.queueWrite((metrics) => {
    const quirks = summarizeParserDiagnostics(sample.diagnostics);
    const repaired = QUIRK_KEYS.some((key) => quirks[key] > 0);
    const entry = {
      at: Date.now(),
      ok: sample.ok === true,
      repaired,
      recoveredAfterRetry: sample.recoveredAfterRetry === true,
      scope: sample.scope === 'resplit' ? 'resplit' : 'primary',
      attempt: Math.max(1, nonNegative(sample.attempt)),
      sentenceCount: nonNegative(sample.diagnostics?.sentenceCount),
      inputLineCount: nonNegative(sample.diagnostics?.inputLineCount),
      parsedRangeCount: nonNegative(sample.diagnostics?.parsedRangeCount),
      error: typeof sample.error === 'string' ? sample.error.slice(0, 160) : '',
      quirks,
    };
    metrics.totalCount++;
    if (entry.ok) metrics.successCount++;
    else metrics.failureCount++;
    if (entry.ok && repaired) metrics.repairedCount++;
    if (entry.recoveredAfterRetry) metrics.retryRecoveredCount++;
    for (const key of QUIRK_KEYS) metrics.totals[key] += quirks[key];
    metrics.recent.unshift(entry);
    metrics.recent = metrics.recent.slice(0, PARSER_METRICS_MAX_RECENT);
    return metrics;
  });
}

export function clearParserMetrics() {
  return store.clear();
}
