import { CHAT_TOOL_OUTCOMES } from '../shared/runtime/telemetry.js';

export const HIGHLIGHT_SPAN_TOOL = Object.freeze({
  name: 'highlight_span',
  description:
    'Highlight one or more consecutive article sentences. Use the 1-based line numbers shown in the article context.',
  parameters: {
    type: 'object',
    properties: {
      start_line: {
        type: 'integer',
        description: 'First line number, 1-based and inclusive.',
      },
      end_line: {
        type: 'integer',
        description: 'Last line number, 1-based and inclusive.',
      },
      label: {
        type: 'string',
        description:
          'Optional very short tag (max ~6 words) naming why this passage matters. A tag, not a sentence — do not summarize the passage.',
      },
    },
    required: ['start_line', 'end_line'],
    additionalProperties: false,
  },
});

/**
 * @param {{startLine: number, endLine: number}} a First range.
 * @param {{startLine: number, endLine: number}} b Second range.
 * @returns {boolean}
 */
export function rangesOverlap(a, b) {
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * A tool-call validation failure, tagged with a stable `code` so callers can
 * classify the outcome without matching on the human-facing message text.
 * @param {string} message Human-facing error message.
 * @param {string} code Stable error code.
 */
function toolArgError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Validate one model-issued highlight range against the article and against
 * the chunk the model was actually shown.
 * @param {object} args Raw tool arguments.
 * @param {number} sentenceCount Article sentence count.
 * @param {{startLine?: number, endLine?: number}} [visible] Lines the model was shown.
 * @returns {{startLine: number, endLine: number, label: string}}
 */
export function validateHighlightArgs(
  args,
  sentenceCount,
  { startLine: visibleStartLine = 1, endLine: visibleEndLine = sentenceCount } = {},
) {
  const startLine = Number(args?.start_line);
  const endLine = Number(args?.end_line);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
    throw toolArgError(
      'start_line and end_line must be integers',
      CHAT_TOOL_OUTCOMES.INVALID_ARGUMENTS,
    );
  }
  if (startLine < 1 || endLine < startLine || endLine > sentenceCount) {
    throw toolArgError(
      `line range must be between 1 and ${sentenceCount}`,
      CHAT_TOOL_OUTCOMES.OUT_OF_RANGE,
    );
  }
  if (startLine < visibleStartLine || endLine > visibleEndLine) {
    throw toolArgError(
      `line range must stay within the supplied lines ${visibleStartLine}-${visibleEndLine}`,
      CHAT_TOOL_OUTCOMES.OUT_OF_CHUNK,
    );
  }
  return {
    startLine,
    endLine,
    label: typeof args?.label === 'string' ? args.label : '',
  };
}
