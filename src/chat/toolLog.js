// User-facing log of the tools a chat turn called. Each entry keeps only the
// call's name, compact arguments and outcome: never tool results or provider
// reasoning, so it is safe to persist with the assistant message.

/**
 * @typedef {object} ToolLogEntry
 * @property {string} name Tool name as called by the model.
 * @property {string} args Compact JSON of the call arguments, truncated.
 * @property {string} outcome A CHAT_TOOL_OUTCOMES value.
 * @property {string} [error] Short error text for a failed call.
 */

export const TOOL_LOG_NAME_MAX_CHARS = 80;
export const TOOL_LOG_ARGS_MAX_CHARS = 300;
export const TOOL_LOG_ERROR_MAX_CHARS = 200;
// Generous bound for one turn (rounds × calls per round across chunks).
export const TOOL_LOG_MAX_ENTRIES = 200;

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function stringifyArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch (_) {
    return String(args);
  }
}

/**
 * Build the log entry for one resolved tool call.
 * @param {{name?: string, arguments?: unknown}} call
 * @param {string} outcome
 * @param {string} [error]
 * @returns {ToolLogEntry}
 */
export function createToolLogEntry(call, outcome, error) {
  return {
    name: truncate(call?.name || '(missing name)', TOOL_LOG_NAME_MAX_CHARS),
    args: truncate(stringifyArgs(call?.arguments), TOOL_LOG_ARGS_MAX_CHARS),
    outcome: truncate(outcome || '', TOOL_LOG_NAME_MAX_CHARS),
    ...(error ? { error: truncate(error, TOOL_LOG_ERROR_MAX_CHARS) } : {}),
  };
}

/**
 * Validate a stored/untrusted tool log. Returns null when there is nothing to keep.
 * @param {unknown} value
 * @returns {ToolLogEntry[] | null}
 */
export function normalizeToolLog(value) {
  if (!Array.isArray(value)) return null;
  const entries = value
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.name === 'string')
    .slice(0, TOOL_LOG_MAX_ENTRIES)
    .map((entry) => ({
      name: truncate(entry.name, TOOL_LOG_NAME_MAX_CHARS),
      args: truncate(typeof entry.args === 'string' ? entry.args : '', TOOL_LOG_ARGS_MAX_CHARS),
      outcome: truncate(
        typeof entry.outcome === 'string' ? entry.outcome : '',
        TOOL_LOG_NAME_MAX_CHARS,
      ),
      ...(typeof entry.error === 'string' && entry.error
        ? { error: truncate(entry.error, TOOL_LOG_ERROR_MAX_CHARS) }
        : {}),
    }));
  return entries.length ? entries : null;
}
