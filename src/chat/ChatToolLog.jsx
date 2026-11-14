import React from 'react';
import { CHAT_TOOL_OUTCOMES } from '../shared/runtime/telemetry.js';

const OUTCOME_LABELS = Object.freeze({
  [CHAT_TOOL_OUTCOMES.HIGHLIGHTED]: 'highlighted',
  [CHAT_TOOL_OUTCOMES.TOOL_RESULT]: 'ok',
  [CHAT_TOOL_OUTCOMES.TOOL_FAILED]: 'failed',
  [CHAT_TOOL_OUTCOMES.BUDGET_EXHAUSTED]: 'skipped: budget',
  [CHAT_TOOL_OUTCOMES.OVERLAP_SKIPPED]: 'skipped: overlap',
  [CHAT_TOOL_OUTCOMES.UNKNOWN_TOOL]: 'unknown tool',
  [CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS]: 'invalid arguments',
  [CHAT_TOOL_OUTCOMES.OUT_OF_RANGE]: 'out of range',
  [CHAT_TOOL_OUTCOMES.OUT_OF_CHUNK]: 'out of chunk',
  [CHAT_TOOL_OUTCOMES.PAINT_FAILED]: 'paint failed',
});

const OK_OUTCOMES = new Set([CHAT_TOOL_OUTCOMES.HIGHLIGHTED, CHAT_TOOL_OUTCOMES.TOOL_RESULT]);

/**
 * Foldable list of the tools one assistant turn called.
 *
 * @param {object} props
 * @param {Array<{name: string, args: string, outcome: string, error?: string}>} props.entries
 * @param {boolean} [props.live] The turn is still running.
 */
function ChatToolLog({ entries, live = false }) {
  if (!entries?.length) return null;
  const count = entries.length;
  return (
    <details className="pagetollm-chat-tools">
      <summary>
        {live ? 'Calling tools' : 'Tools called'} ({count})
      </summary>
      <ol>
        {entries.map((entry, index) => {
          const ok = OK_OUTCOMES.has(entry.outcome);
          return (
            <li key={index} className={ok ? '' : 'is-failed'} title={entry.error || undefined}>
              <code className="pagetollm-chat-tool-name">{entry.name}</code>
              {entry.args ? <code className="pagetollm-chat-tool-args">{entry.args}</code> : null}
              <em className="pagetollm-chat-tool-outcome">
                {OUTCOME_LABELS[entry.outcome] || entry.outcome}
              </em>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

export default React.memo(ChatToolLog);
