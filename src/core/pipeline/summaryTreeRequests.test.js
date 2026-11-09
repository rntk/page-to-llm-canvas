import { describe, expect, it, vi } from 'vitest';
import { createSummaryTreeJudge } from './summaryTreeRequests.js';
import { decisionRequestFits } from '../llm/decisionClient.js';

const question = (text) => ({ type: 'noul', instructions: text });

function answerAll(_state, questions) {
  return {
    answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { name }])),
  };
}

describe('summary tree judge decision budget', () => {
  it('sends a request that fits the decision context window unchanged', async () => {
    const decide = vi.fn(answerAll);
    const judge = createSummaryTreeJudge({ decide, contextWindowTokens: 100_000 });
    const answers = await judge.ask({ path: 'Root' }, { a: question('A'), b: question('B') });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(Object.keys(answers)).toEqual(['a', 'b']);
  });

  it('splits oversized requests until every part fits, and merges the answers', async () => {
    const contextWindowTokens = 1200;
    const decide = vi.fn((state, questions) => {
      expect(decisionRequestFits(state, questions, contextWindowTokens)).toBe(true);
      return answerAll(state, questions);
    });
    const questions = Object.fromEntries(
      Array.from({ length: 8 }, (_, i) => [`q${i}`, question('x'.repeat(200))]),
    );
    const judge = createSummaryTreeJudge({ decide, contextWindowTokens });
    const answers = await judge.ask({ path: 'Root' }, questions);
    expect(decide.mock.calls.length).toBeGreaterThan(1);
    expect(Object.keys(answers).sort()).toEqual(Object.keys(questions).sort());
    expect(judge.active).toBe(true);
  });

  it('narrows the state to the questions of each part', async () => {
    const contextWindowTokens = 1000;
    const decide = vi.fn(answerAll);
    const claims = { s0: 'a'.repeat(600), s1: 'b'.repeat(600) };
    const judge = createSummaryTreeJudge({ decide, contextWindowTokens });
    const answers = await judge.ask(
      { claims },
      { s0: question('s0'), s1: question('s1') },
      {
        narrow: (state, keys) => ({
          claims: Object.fromEntries(keys.map((key) => [key, state.claims[key]])),
        }),
      },
    );
    expect(decide.mock.calls.map(([state]) => Object.keys(state.claims))).toEqual([['s0'], ['s1']]);
    expect(Object.keys(answers)).toEqual(['s0', 's1']);
  });

  it('leaves a single oversized question unanswered without a request or disabling', async () => {
    const decide = vi.fn(answerAll);
    const log = vi.fn(async () => {});
    const judge = createSummaryTreeJudge({ decide, runtime: { log }, contextWindowTokens: 300 });
    expect(await judge.ask({ text: 'x'.repeat(2000) }, { only: question('Q') })).toBeNull();
    expect(await judge.ask({ text: 'x'.repeat(2000) }, { only: question('Q') })).toBeNull();
    expect(decide).not.toHaveBeenCalled();
    expect(judge.active).toBe(true);
    expect(judge.metrics.oversized).toBe(2);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('summary_tree_decision_too_large', {
      contextWindowTokens: 300,
    });
  });

  it('does not constrain requests when the context window is unknown', async () => {
    const decide = vi.fn(answerAll);
    const judge = createSummaryTreeJudge({ decide });
    await judge.ask({ text: 'x'.repeat(50_000) }, { only: question('Q') });
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
