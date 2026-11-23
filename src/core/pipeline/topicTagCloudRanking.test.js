import { describe, expect, it, vi } from 'vitest';
import { decisionRequestFits } from '../llm/decisionClient.js';
import { rankTopicWords } from './topicTagCloudRanking.js';

function answerQuestions(questions, score) {
  return {
    answers: Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [
        id,
        { probabilities: { yes: score(question.instructions.word) } },
      ]),
    ),
  };
}

describe('rankTopicWords', () => {
  it('ranks distinct source spellings and discards low and ambiguous relevance', async () => {
    const scores = { Café: 0.7, résumés: 0.94, menus: 0.69, example: 0.05 };
    const decide = vi.fn(async (state, questions) => {
      expect(state.topic_title).toBe('Documents');
      for (const question of Object.values(questions)) {
        const { word, occurrence } = question.instructions;
        expect(state.source_text).toContain(word);
        expect(occurrence).toContain(word);
      }
      return answerQuestions(questions, (word) => scores[word]);
    });
    await expect(
      rankTopicWords({
        text: 'Café café and résumés, menus for the example.',
        title: 'Documents',
        decide,
      }),
    ).resolves.toEqual([
      { word: 'résumés', weight: 0.94 },
      { word: 'Café', weight: 0.7 },
    ]);
    expect(Object.values(decide.mock.calls[0][1])).toHaveLength(4);
  });

  it('bounds both the number of candidates and request context', async () => {
    const text = Array.from({ length: 70 }, (_, index) => `subject${index}`).join(' ');
    const contextWindowTokens = 1024;
    const decide = vi.fn(async (state, questions) => {
      expect(Object.keys(questions).length).toBeLessThanOrEqual(8);
      expect(decisionRequestFits(state, questions, contextWindowTokens)).toBe(true);
      return answerQuestions(questions, () => 0.85);
    });
    const result = await rankTopicWords({ text, decide, contextWindowTokens });
    const askedCount = decide.mock.calls.reduce(
      (count, [, questions]) => count + Object.keys(questions).length,
      0,
    );
    expect(decide.mock.calls.length).toBeGreaterThan(1);
    expect(askedCount).toBe(24);
    expect(result).toHaveLength(16);
  });

  it('packs common batches into three requests with limited shared text', async () => {
    const text = Array.from({ length: 100 }, (_, index) => `subject${index} 情報資料`).join(' ');
    const decide = vi.fn(async (state, questions) => {
      expect(state.source_text.length).toBeLessThanOrEqual(1000);
      expect(decisionRequestFits(state, questions, 4096)).toBe(true);
      expect(Object.keys(questions)).toHaveLength(8);
      return answerQuestions(questions, () => 0.85);
    });
    await rankTopicWords({ text, decide });
    expect(decide).toHaveBeenCalledTimes(3);
  });

  it('returns no tags without calling Decisions when there are no candidates', async () => {
    const decide = vi.fn();
    await expect(rankTopicWords({ text: 'The and 123 ...', decide })).resolves.toEqual([]);
    expect(decide).not.toHaveBeenCalled();
  });

  it('keeps source initialisms and May when they overlap with common words', async () => {
    const decide = vi.fn(async (_state, questions) => answerQuestions(questions, () => 0.9));
    await expect(rankTopicWords({ text: 'it may and US IT May', decide })).resolves.toEqual([
      { word: 'US', weight: 0.9 },
      { word: 'IT', weight: 0.9 },
      { word: 'May', weight: 0.9 },
    ]);
  });

  it('preserves transport errors and rejects malformed model answers', async () => {
    const error = Object.assign(new Error('Service unavailable'), { status: 503 });
    const decide = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce({ answers: {} });
    await expect(rankTopicWords({ text: 'topic', decide })).rejects.toBe(error);
    await expect(rankTopicWords({ text: 'topic', decide })).rejects.toThrow('valid score');
  });

  it('passes cancellation to Decisions and ignores a response after cancellation', async () => {
    const controller = new AbortController();
    const decide = vi.fn(async (_state, questions, { signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      return answerQuestions(questions, () => 0.9);
    });
    await expect(
      rankTopicWords({ text: 'topic', decide, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
