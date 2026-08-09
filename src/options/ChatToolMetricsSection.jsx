import React, { useCallback, useEffect, useState } from 'react';
import {
  CHAT_TOOL_METRICS_KEY,
  CHAT_TOOL_OUTCOME_LABELS,
  emptyChatToolMetrics,
  getChatToolMetrics,
  isErrorOutcome,
  normalizeChatToolMetrics,
} from '../../worker/metrics/chatTool.js';
import { MSG } from '../shared/runtime/messages.js';
import { sendRuntimeMessage } from '../utils/runtimeMessages.js';
import { CollapsibleSection } from './CollapsibleSection.jsx';

function formatDate(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleString() : '—';
}

function outcomeLabel(outcome) {
  return CHAT_TOOL_OUTCOME_LABELS[outcome] || outcome;
}

// Outcomes ordered so accepted highlights lead and error cases group at the end.
const OUTCOME_ORDER = Object.keys(CHAT_TOOL_OUTCOME_LABELS);

export function ChatToolMetricsSection() {
  const [metrics, setMetrics] = useState(() => emptyChatToolMetrics());
  const [isClearing, setIsClearing] = useState(false);

  useEffect(() => {
    let current = true;
    void getChatToolMetrics()
      .then((stored) => current && setMetrics(stored))
      .catch((err) => {
        console.warn('PageToLLM Options chat tool metrics load failed:', err);
      });
    const onChanged = (changes, areaName) => {
      if (areaName === 'local' && changes?.[CHAT_TOOL_METRICS_KEY]) {
        setMetrics(normalizeChatToolMetrics(changes[CHAT_TOOL_METRICS_KEY].newValue));
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
    try {
      // Route through the worker so the clear serializes with worker-side
      // records on one writeChain (see the clearChatToolMetrics handler).
      const response = await sendRuntimeMessage({ type: MSG.clearChatToolMetrics });
      if (!response?.ok) {
        throw new Error(response?.error || 'Failed to clear chat tool metrics');
      }
      setMetrics(emptyChatToolMetrics());
    } catch (_) {
      const stored = await getChatToolMetrics();
      setMetrics(stored);
    } finally {
      setIsClearing(false);
    }
  }, []);

  const outcomes = OUTCOME_ORDER.filter((outcome) => metrics.byOutcome[outcome] > 0);

  return (
    <CollapsibleSection title="Chat Tool Calls">
      <div className="toolbar">
        <div className="note">
          Outcome of every highlight_span tool call the assistant makes while chatting about an
          article — accepted highlights, benign skips, and calls rejected as wrong or malformed. No
          prompts, responses, article text, or highlight labels are stored.
        </div>
        <button type="button" onClick={handleClear} disabled={isClearing || !metrics.totalCount}>
          {isClearing ? 'Clearing...' : 'Clear chat tool metrics'}
        </button>
      </div>
      {!metrics.totalCount ? (
        <div className="empty">No chat tool calls recorded yet.</div>
      ) : (
        <>
          <div className="field">
            <table>
              <tbody>
                <tr>
                  <th scope="row">Tool calls (ok / error)</th>
                  <td className="mono">
                    {metrics.totalCount} ({metrics.okCount} / {metrics.errorCount})
                  </td>
                </tr>
                {outcomes.map((outcome) => (
                  <tr key={outcome}>
                    <th scope="row">{outcomeLabel(outcome)}</th>
                    <td className="mono">{metrics.byOutcome[outcome]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {metrics.recent.length > 0 ? (
            <CollapsibleSection variant="field" title="Recent tool calls (newest first)">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Outcome</th>
                    <th>Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.recent.map((entry, index) => (
                    <tr key={`${entry.at}-${index}`}>
                      <td>{formatDate(entry.at)}</td>
                      <td title={isErrorOutcome(entry.outcome) ? 'error' : 'ok'}>
                        {outcomeLabel(entry.outcome)}
                      </td>
                      <td>{entry.error || '—'}</td>
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
