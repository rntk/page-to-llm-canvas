import React, { useCallback, useState } from 'react';
import {
  PARSER_METRICS_KEY,
  emptyParserMetrics,
  getParserMetrics,
  normalizeParserMetrics,
} from '../../worker/metrics/parser.js';
import { MSG } from '../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { CollapsibleSection } from './CollapsibleSection.jsx';
import { useStoredMetrics } from './useStoredMetrics.js';

function formatDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : '—';
}

function quirksLabel(quirks) {
  const parts = [];
  if (quirks.invalidRangeTokens) parts.push(`${quirks.invalidRangeTokens} invalid token(s)`);
  if (quirks.outOfRangeRanges) parts.push(`${quirks.outOfRangeRanges} clamped range(s)`);
  if (quirks.duplicateSentences) parts.push(`${quirks.duplicateSentences} overlap(s)`);
  if (quirks.missingSentences) parts.push(`${quirks.missingSentences} gap(s)`);
  if (quirks.reversedRanges) parts.push(`${quirks.reversedRanges} reversed range(s)`);
  if (quirks.ignoredLines) parts.push(`${quirks.ignoredLines} ignored line(s)`);
  return parts.join(', ') || 'none';
}

export function ParserMetricsSection({ store }) {
  const [metrics, setMetrics] = useStoredMetrics({
    storageKey: PARSER_METRICS_KEY,
    read: getParserMetrics,
    normalize: normalizeParserMetrics,
    empty: emptyParserMetrics,
    subscribe: store.subscribe,
    loadErrorMessage: 'PageToLLM Options parser metrics load failed:',
  });
  const [isClearing, setIsClearing] = useState(false);
  const [clearError, setClearError] = useState('');

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    setClearError('');
    try {
      const response = await sendRuntimeMessage({ type: MSG.clearParserMetrics });
      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to clear parser metrics');
      }
      setMetrics(emptyParserMetrics());
    } catch (error) {
      // A failed clear leaves the stored counters intact. Reload them so the
      // user can see the current data and try again instead of being left in
      // a permanently busy state.
      let message = error?.message || 'Failed to clear parser metrics';
      try {
        const stored = await getParserMetrics();
        setMetrics(stored);
      } catch (reloadError) {
        message += `. Metrics could not be reloaded: ${reloadError?.message || String(reloadError)}`;
      }
      setClearError(message);
    } finally {
      setIsClearing(false);
    }
  }, [setMetrics]);

  return (
    <CollapsibleSection title="Topic Parser Quality">
      <div className="toolbar">
        <div className="note">
          Privacy-safe counts of malformed model output and deterministic parser repairs. No page
          text, prompts, responses, URLs, record IDs, or topic labels are stored.
        </div>
        <button type="button" onClick={handleClear} disabled={isClearing || !metrics.totalCount}>
          {isClearing ? 'Clearing...' : 'Clear parser metrics'}
        </button>
      </div>
      {clearError ? (
        <div className="form-error form-error--stacked" role="alert">
          {clearError}
        </div>
      ) : null}
      {!metrics.totalCount ? (
        <div className="empty">No topic parser attempts recorded yet.</div>
      ) : (
        <>
          <div className="field">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Attempts (ok / error)</th>
                  <td className="mono">
                    {metrics.totalCount} ({metrics.successCount} / {metrics.failureCount})
                  </td>
                </tr>
                <tr>
                  <th scope="row">Successful parses needing repair</th>
                  <td className="mono">{metrics.repairedCount}</td>
                </tr>
                <tr>
                  <th scope="row">Recovered after parser retry</th>
                  <td className="mono">{metrics.retryRecoveredCount}</td>
                </tr>
                <tr>
                  <th scope="row">Invalid range tokens</th>
                  <td className="mono">{metrics.totals.invalidRangeTokens}</td>
                </tr>
                <tr>
                  <th scope="row">Out-of-bounds ranges clamped</th>
                  <td className="mono">{metrics.totals.outOfRangeRanges}</td>
                </tr>
                <tr>
                  <th scope="row">Overlapping sentences repaired</th>
                  <td className="mono">{metrics.totals.duplicateSentences}</td>
                </tr>
                <tr>
                  <th scope="row">Missing sentences filled</th>
                  <td className="mono">{metrics.totals.missingSentences}</td>
                </tr>
                <tr>
                  <th scope="row">Reversed ranges normalized</th>
                  <td className="mono">{metrics.totals.reversedRanges}</td>
                </tr>
                <tr>
                  <th scope="row">Unusable response lines ignored</th>
                  <td className="mono">{metrics.totals.ignoredLines}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="field">
            <div className="note note--stacked">Recent parser attempts (newest first)</div>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Scope</th>
                  <th>Attempt</th>
                  <th>Sentences / lines / ranges</th>
                  <th>Result</th>
                  <th>Quirks and repairs</th>
                </tr>
              </thead>
              <tbody>
                {metrics.recent.map((entry, index) => (
                  <tr key={`${entry.at}-${index}`}>
                    <td>{formatDate(entry.at)}</td>
                    <td>{entry.scope}</td>
                    <td className="mono">{entry.attempt}</td>
                    <td className="mono">
                      {entry.sentenceCount} / {entry.inputLineCount || '—'} /{' '}
                      {entry.parsedRangeCount || '—'}
                    </td>
                    <td title={entry.error || undefined}>
                      {entry.ok
                        ? entry.recoveredAfterRetry
                          ? 'recovered'
                          : entry.repaired
                            ? 'repaired'
                            : 'clean'
                        : 'error'}
                    </td>
                    <td>{quirksLabel(entry.quirks)}</td>
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
