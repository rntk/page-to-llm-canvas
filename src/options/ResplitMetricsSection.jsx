import React from 'react';
import {
  RESPLIT_METRICS_KEY,
  RESPLIT_OUTCOMES,
  SPAN_BUCKET_KEYS,
  emptyResplitMetrics,
  getResplitMetrics,
  normalizeResplitMetrics,
} from '../../worker/metrics/resplit.js';
import { MSG } from '../shared/runtime/messages.js';
import { CollapsibleSection } from './CollapsibleSection.jsx';
import { formatDate } from './metricsFormat.js';
import { useMetricsClear } from './useMetricsClear.js';
import { useStoredMetrics } from './useStoredMetrics.js';

const OUTCOME_LABELS = {
  [RESPLIT_OUTCOMES.SUBDIVIDED]: 'subdivided',
  [RESPLIT_OUTCOMES.ACCEPTED_SINGLE]: 'acceptedSingle',
  [RESPLIT_OUTCOMES.WINDOW_FALLBACK]: 'windowFallback',
  [RESPLIT_OUTCOMES.NO_PROGRESS]: 'noProgress',
  [RESPLIT_OUTCOMES.ERROR]: 'error',
};

const SPAN_BUCKET_LABELS = {
  le60: '41-60',
  le80: '61-80',
  le120: '81-120',
  le240: '121-240',
  gt240: '>240',
};

function pct(numerator, denominator) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function outcomesLabel(outcomes) {
  return Object.entries(outcomes)
    .map(([key, value]) => `${OUTCOME_LABELS[key] ?? key}: ${value}`)
    .join(', ');
}

function bucketsLabel(buckets) {
  return SPAN_BUCKET_KEYS.map((key) => `${SPAN_BUCKET_LABELS[key]}: ${buckets[key] ?? 0}`).join(
    ', ',
  );
}

export function ResplitMetricsSection({ store }) {
  const [metrics, setMetrics] = useStoredMetrics({
    storageKey: RESPLIT_METRICS_KEY,
    read: getResplitMetrics,
    normalize: normalizeResplitMetrics,
    empty: emptyResplitMetrics,
    subscribe: store.subscribe,
    loadErrorMessage: 'PageToLLM Options resplit metrics load failed:',
  });
  const { isClearing, clearError, handleClear } = useMetricsClear({
    messageType: MSG.clearResplitMetrics,
    defaultErrorMessage: 'Failed to clear resplit metrics',
    empty: emptyResplitMetrics,
    read: getResplitMetrics,
    setMetrics,
  });

  return (
    <CollapsibleSection title="Topic Range Resplit">
      <div className="toolbar">
        <div className="note">
          Privacy-safe counts of oversized-range resplitting. The removal decision hinges on
          &quot;Runs that produced extra topics&quot; below: if that stays at or near zero across
          many runs, the resplit stage can be removed. No page text, prompts, responses, URLs,
          record IDs, or topic labels are stored.
        </div>
        <button type="button" onClick={handleClear} disabled={isClearing || !metrics.runCount}>
          {isClearing ? 'Clearing...' : 'Clear resplit metrics'}
        </button>
      </div>
      {clearError ? (
        <div className="form-error form-error--stacked" role="alert">
          {clearError}
        </div>
      ) : null}
      {!metrics.runCount ? (
        <div className="empty">No topic range resplit runs recorded yet.</div>
      ) : (
        <>
          <div className="field">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Runs reaching the resplit check</th>
                  <td className="mono">{metrics.runCount}</td>
                </tr>
                <tr>
                  <th scope="row">Runs with oversized ranges</th>
                  <td className="mono">
                    {metrics.runsWithOversize} ({pct(metrics.runsWithOversize, metrics.runCount)})
                  </td>
                </tr>
                <tr>
                  <th scope="row">Runs where resplit changed grouping</th>
                  <td className="mono">
                    {metrics.runsChanged} ({pct(metrics.runsChanged, metrics.runCount)})
                  </td>
                </tr>
                <tr>
                  <th scope="row">Runs that produced extra topics</th>
                  <td className="mono">
                    <strong>
                      {metrics.runsWithGroupGain} (
                      {pct(metrics.runsWithGroupGain, metrics.runCount)})
                    </strong>
                  </td>
                </tr>
                <tr>
                  <th scope="row">Oversized ranges seen</th>
                  <td className="mono">{metrics.oversizeSegmentCount}</td>
                </tr>
                <tr>
                  <th scope="row">Resplit invocations</th>
                  <td className="mono">{metrics.resplitCallCount}</td>
                </tr>
                <tr>
                  <th
                    scope="row"
                    title="LLM requests the primary topic-ranges stage issued in the same runs; the baseline resplit's cost is measured against"
                  >
                    Baseline topic-range requests
                  </th>
                  <td className="mono">{metrics.primaryRequestCount}</td>
                </tr>
                <tr>
                  <th
                    scope="row"
                    title="Excludes the LLM client's internal transport retries, so this is a lower bound"
                  >
                    LLM requests spent
                  </th>
                  <td className="mono">
                    {metrics.llmRequestCount}
                    {metrics.primaryRequestCount
                      ? ` (+${pct(
                          metrics.llmRequestCount - metrics.primaryRequestCount,
                          metrics.primaryRequestCount,
                        )} over baseline)`
                      : ''}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Largest range span</th>
                  <td className="mono">{metrics.maxSpanObserved}</td>
                </tr>
                <tr>
                  <th scope="row">Outcome breakdown</th>
                  <td className="mono">{outcomesLabel(metrics.outcomes)}</td>
                </tr>
                <tr>
                  <th scope="row">Oversize span histogram</th>
                  <td className="mono">{bucketsLabel(metrics.oversizeSpanBuckets)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="field">
            <div className="note note--stacked">Recent resplit runs (newest first)</div>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Segments</th>
                  <th>Oversized</th>
                  <th>Max span</th>
                  <th>Resplit calls</th>
                  <th title="Excludes the LLM client's internal transport retries, so this is a lower bound">
                    LLM requests
                  </th>
                  <th>Changed</th>
                  <th>Groups before-&gt;after</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recent.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td>{formatDate(entry.at)}</td>
                    <td className="mono">{entry.segmentCount}</td>
                    <td className="mono">{entry.oversizeCount}</td>
                    <td className="mono">{entry.maxSpan}</td>
                    <td className="mono">{entry.resplitCallCount}</td>
                    <td className="mono">{entry.llmRequestCount}</td>
                    <td>{entry.changed ? 'yes' : 'no'}</td>
                    <td className="mono">
                      {entry.groupCountBefore} -&gt; {entry.groupCountAfter}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </CollapsibleSection>
  );
}
