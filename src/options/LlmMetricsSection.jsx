import React, { useCallback, useEffect, useState } from 'react';
import {
  LLM_METRICS_KEY,
  emptyLlmMetrics,
  getLlmMetrics,
  clearLlmMetrics,
  normalizeLlmMetrics,
} from '../../worker/llmMetrics.js';
import {
  averageDurationMs,
  cacheHitRate,
  formatDurationMs,
  formatMetricCount,
  formatMetricPercent,
  formatTaskTypeLabel,
  listTaskTypes,
} from '../../worker/llmMetricsFormat.js';
import { CollapsibleSection } from './CollapsibleSection.jsx';

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

export function LlmMetricsSection() {
  const [metrics, setMetrics] = useState(() => emptyLlmMetrics());
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    async function loadMetrics() {
      const stored = await getLlmMetrics();
      if (isCurrent) setMetrics(stored);
    }

    void loadMetrics();
    const handleStorageChange = (changes, areaName) => {
      if (areaName !== 'local' || !changes || !changes[LLM_METRICS_KEY]) return;
      setMetrics(normalizeLlmMetrics(changes[LLM_METRICS_KEY].newValue));
    };
    try {
      chrome.storage.onChanged.addListener(handleStorageChange);
    } catch (_) {
      /* noop */
    }
    return () => {
      isCurrent = false;
      try {
        chrome.storage.onChanged.removeListener(handleStorageChange);
      } catch (_) {
        /* noop */
      }
    };
  }, []);

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    try {
      await clearLlmMetrics();
      setMetrics(emptyLlmMetrics());
    } catch (_) {
      const stored = await getLlmMetrics();
      setMetrics(stored);
    } finally {
      setIsClearing(false);
    }
  }, []);

  const average = averageDurationMs(metrics);
  const taskTypes = listTaskTypes(metrics);
  const hasUsage = metrics.usageSampleCount > 0;
  const hasCacheUsage = metrics.cacheSampleCount > 0;

  return (
    <CollapsibleSection title="LLM Request Metrics">
      <div className="toolbar">
        <div className="note">
          Duration, token usage, prompt-cache reuse, and response sizes for model requests made
          while processing pages and chatting about articles. Durations include retries; provider
          usage is recorded when the API reports it.
        </div>
        <div>
          <button
            type="button"
            onClick={handleClear}
            disabled={isClearing || metrics.totalCount === 0}
          >
            {isClearing ? 'Clearing...' : 'Clear metrics'}
          </button>
        </div>
      </div>
      {metrics.totalCount === 0 ? (
        <div className="empty">No LLM requests recorded yet.</div>
      ) : (
        <>
          <div className="field">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Total requests</th>
                  <td className="mono">{metrics.totalCount}</td>
                </tr>
                <tr>
                  <th scope="row">Succeeded / failed</th>
                  <td className="mono">
                    {metrics.successCount} / {metrics.failureCount}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Average</th>
                  <td className="mono">{formatDurationMs(average)}</td>
                </tr>
                <tr>
                  <th scope="row">Min / max</th>
                  <td className="mono">
                    {formatDurationMs(metrics.minDurationMs)} /{' '}
                    {formatDurationMs(metrics.maxDurationMs)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Input / output tokens</th>
                  <td className="mono">
                    {formatMetricCount(hasUsage ? metrics.totalInputTokens : null)} /{' '}
                    {formatMetricCount(hasUsage ? metrics.totalOutputTokens : null)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Total tokens</th>
                  <td className="mono">
                    {formatMetricCount(hasUsage ? metrics.totalTokens : null)}
                  </td>
                </tr>
                {metrics.totalReasoningTokens > 0 ? (
                  <tr>
                    <th scope="row">Reasoning tokens</th>
                    <td className="mono">{formatMetricCount(metrics.totalReasoningTokens)}</td>
                  </tr>
                ) : null}
                <tr>
                  <th scope="row">Cache read / write / uncached</th>
                  <td className="mono">
                    {formatMetricCount(hasCacheUsage ? metrics.totalCacheReadTokens : null)} /{' '}
                    {formatMetricCount(hasCacheUsage ? metrics.totalCacheWriteTokens : null)} /{' '}
                    {formatMetricCount(hasCacheUsage ? metrics.totalCacheMissTokens : null)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Cache hit rate</th>
                  <td className="mono">{formatMetricPercent(cacheHitRate(metrics))}</td>
                </tr>
                <tr>
                  <th scope="row">Prompt / response characters</th>
                  <td className="mono">
                    {formatMetricCount(metrics.totalRequestChars)} /{' '}
                    {formatMetricCount(metrics.totalResponseChars)}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Responses with token usage</th>
                  <td className="mono">
                    {formatMetricCount(metrics.usageSampleCount)} /{' '}
                    {formatMetricCount(metrics.successCount)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {taskTypes.length > 0 ? (
            <CollapsibleSection variant="field" title="By task type">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Requests</th>
                    <th>Ok / err</th>
                    <th>Average</th>
                    <th>Min / max</th>
                  </tr>
                </thead>
                <tbody>
                  {taskTypes.map((taskType) => {
                    const bucket = metrics.byTaskType[taskType] || emptyLlmMetrics();
                    return (
                      <tr key={taskType}>
                        <td>{formatTaskTypeLabel(taskType)}</td>
                        <td className="mono">{bucket.totalCount}</td>
                        <td className="mono">
                          {bucket.successCount} / {bucket.failureCount}
                        </td>
                        <td className="mono">{formatDurationMs(averageDurationMs(bucket))}</td>
                        <td className="mono">
                          {formatDurationMs(bucket.minDurationMs)} /{' '}
                          {formatDurationMs(bucket.maxDurationMs)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CollapsibleSection>
          ) : null}
          {taskTypes.some((taskType) => metrics.byTaskType[taskType]?.usageSampleCount > 0) ? (
            <CollapsibleSection variant="field" title="Token and cache usage by task type">
              <table>
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Reported</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Total</th>
                    <th>Cache read</th>
                    <th>Cache write</th>
                    <th>Uncached</th>
                    <th>Hit rate</th>
                  </tr>
                </thead>
                <tbody>
                  {taskTypes.map((taskType) => {
                    const bucket = metrics.byTaskType[taskType] || emptyLlmMetrics();
                    return (
                      <tr key={taskType}>
                        <td>{formatTaskTypeLabel(taskType)}</td>
                        <td className="mono">{formatMetricCount(bucket.usageSampleCount)}</td>
                        <td className="mono">
                          {formatMetricCount(
                            bucket.usageSampleCount ? bucket.totalInputTokens : null,
                          )}
                        </td>
                        <td className="mono">
                          {formatMetricCount(
                            bucket.usageSampleCount ? bucket.totalOutputTokens : null,
                          )}
                        </td>
                        <td className="mono">
                          {formatMetricCount(bucket.usageSampleCount ? bucket.totalTokens : null)}
                        </td>
                        <td className="mono">
                          {formatMetricCount(
                            bucket.cacheSampleCount ? bucket.totalCacheReadTokens : null,
                          )}
                        </td>
                        <td className="mono">
                          {formatMetricCount(
                            bucket.cacheSampleCount ? bucket.totalCacheWriteTokens : null,
                          )}
                        </td>
                        <td className="mono">
                          {formatMetricCount(
                            bucket.cacheSampleCount ? bucket.totalCacheMissTokens : null,
                          )}
                        </td>
                        <td className="mono">{formatMetricPercent(cacheHitRate(bucket))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </CollapsibleSection>
          ) : null}
          {metrics.recent.length > 0 ? (
            <CollapsibleSection variant="field" title="Recent requests (newest first)">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Task</th>
                    <th>Provider / model</th>
                    <th>Duration</th>
                    <th>Input / output</th>
                    <th>Cache read</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recent.map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td>{formatDate(entry.at)}</td>
                      <td>{formatTaskTypeLabel(entry.taskType)}</td>
                      <td>
                        {entry.provider || entry.model ? (
                          <>
                            {entry.provider || 'Unknown'}
                            {entry.model ? <div className="mono">{entry.model}</div> : null}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="mono">{formatDurationMs(entry.durationMs)}</td>
                      <td className="mono">
                        {formatMetricCount(entry.usage?.inputTokens)} /{' '}
                        {formatMetricCount(entry.usage?.outputTokens)}
                      </td>
                      <td className="mono">{formatMetricCount(entry.usage?.cacheReadTokens)}</td>
                      <td title={entry.error || undefined}>{entry.ok ? 'ok' : 'error'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CollapsibleSection>
          ) : null}
        </>
      )}
    </CollapsibleSection>
  );
}
