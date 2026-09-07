import { describe, it, expect } from 'vitest';
import {
  LLM_MAX_OUTPUT_TOKENS,
  maxTopicRangeSentencesForOutputBudget,
  resolveMaxOutputTokens,
  TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE,
} from './outputBudget.js';

describe('maxTopicRangeSentencesForOutputBudget', () => {
  it('never plans more output than the shared allowance', () => {
    const sentences = maxTopicRangeSentencesForOutputBudget(LLM_MAX_OUTPUT_TOKENS);
    expect(sentences * TOPIC_RANGE_RESPONSE_TOKENS_PER_SENTENCE).toBeLessThanOrEqual(
      LLM_MAX_OUTPUT_TOKENS,
    );
  });

  it('keeps at least one sentence for allowances smaller than one response', () => {
    expect(maxTopicRangeSentencesForOutputBudget(1)).toBe(1);
  });
});

describe('resolveMaxOutputTokens', () => {
  it('narrows the allowance to the declared context window', () => {
    // Asking for more output than the configured window is a non-retryable
    // 400 on Anthropic, which fails every request in the run.
    expect(resolveMaxOutputTokens(8192)).toBeLessThanOrEqual(8192);
    expect(resolveMaxOutputTokens(8192)).toBeLessThan(LLM_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(4096)).toBeLessThanOrEqual(4096);
  });

  it('leaves room in the declared window for the request itself', () => {
    expect(resolveMaxOutputTokens(8192)).toBe(8192 - 1024);
  });

  it('keeps the shared budget when the window is large or undeclared', () => {
    expect(resolveMaxOutputTokens(200_000)).toBe(LLM_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens(undefined)).toBe(LLM_MAX_OUTPUT_TOKENS);
    expect(resolveMaxOutputTokens('')).toBe(LLM_MAX_OUTPUT_TOKENS);
  });

  it('never returns a non-positive allowance', () => {
    expect(resolveMaxOutputTokens(512)).toBe(1);
  });
});
