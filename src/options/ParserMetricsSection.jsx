import React, { useCallback, useEffect, useState } from 'react';
import {
  PARSER_METRICS_KEY,
  clearParserMetrics,
  emptyParserMetrics,
  getParserMetrics,
  normalizeParserMetrics,
} from '../../worker/parserMetrics.js';
import { CollapsibleSection } from './CollapsibleSection.jsx';

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

export function ParserMetricsSection() {
  const [metrics, setMetrics] = useState(() => emptyParserMetrics());
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    let current = true;
    void getParserMetrics().then((stored) => current && setMetrics(stored));
    const onChanged = (changes, areaName) => {
      if (areaName === 'local' && changes?.[PARSER_METRICS_KEY]) {
        setMetrics(normalizeParserMetrics(changes[PARSER_METRICS_KEY].newValue));
      }
    };
    try {
      chrome.storage.onChanged.addListener(onChanged);
    } catch (_) {
      /* noop */
    }
    return () => {
      current = false;
      try {
        chrome.storage.onChanged.removeListener(onChanged);
      } catch (_) {
        /* noop */
      }
    };
  }, []);

  const handleClear = useCallback(async () => {
    setIsClearing(true);
    await clearParserMetrics();
    setMetrics(emptyParserMetrics());
    setIsClearing(false);
  }, []);

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
