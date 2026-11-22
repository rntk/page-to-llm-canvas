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
 * Ranges on different pages (a project chat's `pageUrl`) never overlap; article
 * ranges have no page and compare by lines alone.
 * @param {{startLine: number, endLine: number, pageUrl?: string}} a First range.
 * @param {{startLine: number, endLine: number, pageUrl?: string}} b Second range.
 * @returns {boolean}
 */
export function rangesOverlap(a, b) {
  if ((a.pageUrl || '') !== (b.pageUrl || '')) return false;
  return a.startLine <= b.endLine && b.startLine <= a.endLine;
}

/**
 * Per-turn record of highlighted ranges and the remaining highlight budget,
 * shared by sibling chunk workers. `reserve` checks overlap and spends budget
 * in one synchronous step, so concurrent workers can never both accept an
 * overlapping range or overspend the budget while paints are in flight.
 * @param {Array<{startLine: number, endLine: number, pageUrl?: string}>} initialRanges Ranges already highlighted before this turn.
 * @param {number} maxHighlights Highlights this turn may add.
 */
export function createHighlightLedger(initialRanges, maxHighlights) {
  const ranges = [...(initialRanges || [])];
  let remaining = maxHighlights;
  return {
    /**
     * @param {{startLine: number, endLine: number, pageUrl?: string}} range
     * @returns {'accepted' | 'overlap' | 'exhausted'}
     */
    reserve(range) {
      if (ranges.some((existing) => rangesOverlap(existing, range))) return 'overlap';
      if (remaining <= 0) return 'exhausted';
      remaining -= 1;
      ranges.push(range);
      return 'accepted';
    },
    /** @returns {boolean} */
    isExhausted() {
      return remaining <= 0;
    },
  };
}

/**
 * A tool-call validation failure with a stable `code` for outcome classification.
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
 * @param {{startLine?: number, endLine?: number, lineNumbers?: number[]}} [visible] Lines the model was shown.
 * @returns {{startLine: number, endLine: number, label: string}}
 */
export function validateHighlightArgs(
  args,
  sentenceCount,
  { startLine: visibleStartLine = 1, endLine: visibleEndLine = sentenceCount, lineNumbers } = {},
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
  // Scoped chunks have gaps: both endpoints can be visible while the span between them is not.
  if (
    lineNumbers &&
    new Set(lineNumbers.filter((line) => line >= startLine && line <= endLine)).size !==
      endLine - startLine + 1
  ) {
    throw toolArgError(
      'line range must contain only supplied lines; use separate highlights across gaps',
      CHAT_TOOL_OUTCOMES.OUT_OF_CHUNK,
    );
  }
  return {
    startLine,
    endLine,
    label: typeof args?.label === 'string' ? args.label : '',
  };
}
