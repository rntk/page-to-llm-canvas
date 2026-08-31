import { describe, expect, it } from 'vitest';
import {
  getPipelineTextChunkMaxChars,
  PIPELINE_TEXT_CHUNK_MAX_CHARS,
} from '../pipeline/pipelineConfig.js';
import {
  ARTICLE_CHAT_MAX_CHUNK_CHARS,
  ARTICLE_CHAT_MAX_HISTORY_CHARS,
} from '../settings/articleChatBudget.js';
import { getArticleChatLimits } from './articleChatLimits.js';

describe('getArticleChatLimits', () => {
  it('shares a small provider budget between article source and conversation history', () => {
    const limits = getArticleChatLimits(4096);
    expect(limits.maxChunkChars + limits.maxHistoryChars).toBe(getPipelineTextChunkMaxChars(4096));
    expect(limits.maxHistoryChars).toBeGreaterThan(0);
  });

  it('keeps established defaults when the provider context is unknown', () => {
    expect(getArticleChatLimits(undefined)).toEqual({
      maxChunkChars: ARTICLE_CHAT_MAX_CHUNK_CHARS,
      maxHistoryChars: ARTICLE_CHAT_MAX_HISTORY_CHARS,
    });
  });

  it('keeps the full budget for a context window larger than the pipeline fallback', () => {
    expect(getArticleChatLimits(1_000_000)).toEqual(getArticleChatLimits(undefined));
  });

  it('agrees with the pipeline fallback that signals an unknown window', () => {
    // getArticleChatLimits detects "no declared window" by comparing against
    // the pipeline budget; a drift between the two constants would silently
    // give every unknown provider a small-window split.
    expect(ARTICLE_CHAT_MAX_CHUNK_CHARS).toBe(PIPELINE_TEXT_CHUNK_MAX_CHARS);
  });
});
