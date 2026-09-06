import { describe, it, expect } from 'vitest';
import { FinishReason, isTruncatedFinish, normalizeFinishReason } from './completionStatus.js';

describe('normalizeFinishReason', () => {
  it('maps output-limit reasons from both provider families to TRUNCATED', () => {
    expect(normalizeFinishReason('length')).toBe(FinishReason.TRUNCATED);
    expect(normalizeFinishReason('max_tokens')).toBe(FinishReason.TRUNCATED);
    expect(normalizeFinishReason('model_context_window_exceeded')).toBe(FinishReason.TRUNCATED);
    expect(normalizeFinishReason('LENGTH')).toBe(FinishReason.TRUNCATED);
  });

  it('maps natural stops to COMPLETE', () => {
    expect(normalizeFinishReason('stop')).toBe(FinishReason.COMPLETE);
    expect(normalizeFinishReason('end_turn')).toBe(FinishReason.COMPLETE);
    expect(normalizeFinishReason('stop_sequence')).toBe(FinishReason.COMPLETE);
  });

  it('keeps tool-use finishes distinct from truncation', () => {
    expect(normalizeFinishReason('tool_calls')).toBe(FinishReason.TOOL_CALLS);
    expect(normalizeFinishReason('tool_use')).toBe(FinishReason.TOOL_CALLS);
    expect(isTruncatedFinish(normalizeFinishReason('tool_use'))).toBe(false);
  });

  it('maps blocked completions and upstream errors', () => {
    expect(normalizeFinishReason('content_filter')).toBe(FinishReason.CONTENT_FILTER);
    expect(normalizeFinishReason('refusal')).toBe(FinishReason.CONTENT_FILTER);
    // OpenRouter's non-standard value for an upstream provider failure.
    expect(normalizeFinishReason('error')).toBe(FinishReason.ERROR);
  });

  it('treats missing or unrecognized values as UNKNOWN, never as truncation', () => {
    for (const value of [undefined, null, '', '   ', 42, {}, 'MALFORMED_FUNCTION_CALL']) {
      expect(normalizeFinishReason(value)).toBe(FinishReason.UNKNOWN);
      expect(isTruncatedFinish(normalizeFinishReason(value))).toBe(false);
    }
  });
});
