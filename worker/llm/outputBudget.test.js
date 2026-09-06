import { describe, it, expect } from 'vitest';
import {
  LLM_MAX_OUTPUT_TOKENS,
  maxTopicRangeSentencesForOutputBudget,
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
