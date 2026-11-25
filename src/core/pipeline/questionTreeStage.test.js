import { describe, expect, it, vi } from 'vitest';
import { QUESTION_TREE_STAGE, QUESTION_TREE_STATUS } from '../../shared/runtime/questionTree.js';
import { QuestionTreeError, runQuestionTree } from './questionTreeStage.js';

function makeSentences(count, length = 30) {
  return Array.from({ length: count }, (_, i) => `Sentence ${i + 1} `.padEnd(length, 'x'));
}

function makeRuntime() {
  const saved = [];
  const logs = [];
  return {
    saved,
    logs,
    runtime: {
      signal: undefined,
      maxTextChunkChars: 1000,
      log: vi.fn(async (event, details) => {
        logs.push({ event, details });
      }),
      saveQuestionTree: vi.fn(async (tree) => {
        saved.push(tree);
      }),
    },
  };
}

describe('runQuestionTree', () => {
  it('completes a build, skips grouping for <= 7 questions, and computes metrics', async () => {
    const { runtime, saved, logs } = makeRuntime();
    const record = {
      contentRevision: 'rev-1',
      sentences: ['One.', 'Two.', 'Three.'],
      topics: [{ name: 'Intro', sentences: [1, 2, 3] }],
    };
    const callLLMWithRetry = vi.fn(async () =>
      JSON.stringify({
        sections: [
          {
            question: 'Why read this?',
            answer: 'To understand the topic.',
            start: 1,
            points: [{ text: 'First point', from: ['1', '2'] }],
          },
          {
            question: 'What happens next?',
            answer: 'It concludes.',
            start: 3,
            points: [],
          },
        ],
      }),
    );

    const result = await runQuestionTree({
      runtime,
      record,
      callLLMWithRetry,
      fingerprint: 'fp-1',
      heartbeatMs: 0,
    });

    expect(result.status).toBe(QUESTION_TREE_STATUS.DONE);
    expect(result.stage).toBe(QUESTION_TREE_STAGE.DONE);
    expect(result.groups).toEqual([]);
    expect(result.metrics).toMatchObject({
      chunks: 1,
      failedChunks: 0,
      questions: 2,
      groups: 0,
      points: 1,
      llmCalls: 1,
    });
    expect(saved.at(-1)).toEqual(result);
    expect(logs.map((entry) => entry.event)).toContain('question_tree_done');
  });

  it('resumes completed chunks and retries only failed ones', async () => {
    const { runtime } = makeRuntime();
    const prior = {
      version: 1,
      contentRevision: 'rev-1',
      fingerprint: 'fp-1',
      startedAt: 100,
      chunks: [
        {
          id: 'c1',
          sentences: [1, 2],
          failed: false,
          sections: [{ question: 'Q1?', answer: 'A1.', sentences: [1, 2], points: [] }],
        },
        {
          id: 'c2',
          sentences: [3, 4],
          failed: true,
          sections: null,
        },
      ],
      groups: null,
    };
    const record = {
      contentRevision: 'rev-1',
      sentences: ['S1.', 'S2.', 'S3.', 'S4.'],
      question_tree: prior,
    };
    const callLLMWithRetry = vi.fn(async () =>
      JSON.stringify({
        sections: [{ question: 'Q2?', answer: 'A2.', start: 3, points: [] }],
      }),
    );

    const result = await runQuestionTree({
      runtime,
      record,
      callLLMWithRetry,
      fingerprint: 'fp-1',
      heartbeatMs: 0,
    });

    expect(callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(result.chunks[0].sections[0].question).toBe('Q1?');
    expect(result.chunks[1].sections[0].question).toBe('Q2?');
    expect(result.status).toBe(QUESTION_TREE_STATUS.DONE);
  });

  it('saves completed chunks and throws QuestionTreeError on partial failure', async () => {
    const { runtime, saved } = makeRuntime();
    // 20 sentences * 500 chars -> multiple chunks with maxTextChunkChars = 1200
    const sentences = makeSentences(6, 500);
    const record = { contentRevision: 'rev-1', sentences, topics: [] };

    let calls = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      calls += 1;
      if (prompt.includes('"first_sentence":1')) {
        return JSON.stringify({
          sections: [{ question: 'Q1?', answer: 'A1.', start: 1, points: [] }],
        });
      }
      return 'not json';
    });

    await expect(
      runQuestionTree({
        runtime,
        record,
        callLLMWithRetry,
        fingerprint: 'fp-1',
        workers: 1,
        heartbeatMs: 0,
      }),
    ).rejects.toThrow(QuestionTreeError);

    expect(calls).toBeGreaterThan(1);
    const lastSaved = saved.at(-1);
    expect(lastSaved.chunks[0].sections).toHaveLength(1);
    expect(lastSaved.chunks.some((c) => c.failed)).toBe(true);
  });

  it('groups > 7 questions and fails soft to [] when grouping output is invalid', async () => {
    const { runtime, logs } = makeRuntime();
    const sentences = makeSentences(9, 10);
    const record = { contentRevision: 'rev-1', sentences, topics: [] };

    const sections = sentences.map((_, i) => ({
      question: `Question ${i + 1}?`,
      answer: `Answer ${i + 1}.`,
      start: i + 1,
      points: [],
    }));

    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes('TASK: GROUP QUESTIONS')) {
        return 'invalid grouping';
      }
      return JSON.stringify({ sections });
    });

    const result = await runQuestionTree({
      runtime,
      record,
      callLLMWithRetry,
      fingerprint: 'fp-1',
      heartbeatMs: 0,
    });

    expect(result.status).toBe(QUESTION_TREE_STATUS.DONE);
    expect(result.groups).toEqual([]);
    expect(logs.map((entry) => entry.event)).toContain('question_tree_grouping_skipped');
  });

  it('skips grouping without an LLM call when the serialized questions exceed maxTextChunkChars', async () => {
    const { runtime, logs } = makeRuntime();
    runtime.maxTextChunkChars = 200;
    const sentences = makeSentences(8, 20);
    const record = { contentRevision: 'rev-1', sentences, topics: [] };

    const callLLMWithRetry = vi.fn(async ({ prompt }) => {
      if (prompt.includes('TASK: GROUP QUESTIONS')) {
        throw new Error('Grouping should not be called');
      }
      const matches = [...prompt.matchAll(/"(\d+)":/gu)].map((m) => Number(m[1]));
      return JSON.stringify({
        sections: matches.map((id) => ({
          question: `Question for sentence ${id}?`,
          answer: `Detailed answer for sentence ${id} with plenty of text.`,
          start: id,
          points: [],
        })),
      });
    });

    const result = await runQuestionTree({
      runtime,
      record,
      callLLMWithRetry,
      fingerprint: 'fp-1',
      heartbeatMs: 0,
    });

    expect(result.status).toBe(QUESTION_TREE_STATUS.DONE);
    expect(result.groups).toEqual([]);
    expect(
      callLLMWithRetry.mock.calls.some(([opts]) => opts.prompt.includes('TASK: GROUP QUESTIONS')),
    ).toBe(false);
    expect(logs).toContainEqual({
      event: 'question_tree_grouping_skipped',
      details: expect.objectContaining({
        questionCount: 8,
        reason: 'payload_too_large',
      }),
    });
  });

  it('persists dirty completed chunks as cancelled when stopped within SAVE_INTERVAL_MS', async () => {
    const controller = new AbortController();
    const saved = [];
    const logs = [];
    const runtime = {
      signal: controller.signal,
      maxTextChunkChars: 120,
      log: vi.fn(async (event, details) => {
        logs.push({ event, details });
      }),
      saveQuestionTree: vi.fn(async (tree, options) => {
        saved.push({ tree, options });
      }),
    };
    const sentences = makeSentences(3, 80);
    const record = { contentRevision: 'rev-1', sentences, topics: [] };

    let clock = 10_000;
    let calls = 0;
    const callLLMWithRetry = vi.fn(async ({ prompt, signal }) => {
      calls += 1;
      if (calls === 1) {
        clock += 100;
        const firstId = Number(/"first_sentence":(\d+)/u.exec(prompt)[1]);
        return JSON.stringify({
          sections: [{ question: 'Q1?', answer: 'A1.', start: firstId, points: [] }],
        });
      }
      controller.abort();
      signal.throwIfAborted();
    });

    await expect(
      runQuestionTree({
        runtime,
        record,
        callLLMWithRetry,
        fingerprint: 'fp-1',
        workers: 1,
        heartbeatMs: 0,
        now: () => clock,
      }),
    ).rejects.toThrow();

    expect(saved.length).toBeGreaterThanOrEqual(2);
    const lastSave = saved.at(-1);
    expect(lastSave.options).toEqual({ allowAborted: true });
    expect(lastSave.tree.status).toBe(QUESTION_TREE_STATUS.CANCELLED);
    expect(lastSave.tree.error).toBe('Stopped.');
    expect(lastSave.tree.chunks.some((c) => Array.isArray(c.sections) && c.sections.length === 1)).toBe(
      true,
    );
    expect(
      saved.slice(1, -1).every((entry) => entry.tree.status !== QUESTION_TREE_STATUS.RUNNING),
    ).toBe(true);
  });
});
