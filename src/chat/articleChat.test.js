import { describe, expect, it, vi } from 'vitest';
import {
  buildNumberedArticle,
  chunkNumberedArticle,
  rangesOverlap,
  runArticleChatTurn,
} from './articleChat.js';

describe('article chat tool loop', () => {
  it('numbers article sentences', () => {
    expect(buildNumberedArticle(['First.', 'Second.'])).toBe('1: First.\n2: Second.');
  });

  it('chunks at sentence boundaries while preserving global line numbers', () => {
    expect(chunkNumberedArticle(['First.', '', 'Second.', 'A very long sentence.'], 19)).toEqual([
      { startLine: 1, endLine: 1, text: '1: First.' },
      { startLine: 3, endLine: 3, text: '3: Second.' },
      { startLine: 4, endLine: 4, text: '4: A very long sentence.' },
    ]);
  });

  it('detects overlapping ranges', () => {
    expect(rangesOverlap({ startLine: 2, endLine: 4 }, { startLine: 4, endLine: 5 })).toBe(true);
    expect(rangesOverlap({ startLine: 2, endLine: 3 }, { startLine: 4, endLine: 5 })).toBe(false);
  });

  it('executes highlights, collects the transcript, then yields the final reply', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'highlight_span',
            arguments: { start_line: 2, end_line: 2, label: 'Evidence' },
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, content: 'The second sentence is the evidence.' });
    const onHighlight = vi.fn();

    const result = await runArticleChatTurn({
      history: [{ role: 'user', content: 'Earlier question' }],
      question: 'Where is the evidence?',
      sentences: ['Intro.', 'Evidence.'],
      onHighlight,
      send,
    });

    expect(result.reply).toBe('The second sentence is the evidence.');
    expect(result.highlightRanges).toEqual([{ startLine: 2, endLine: 2, label: 'Evidence' }]);
    expect(onHighlight).toHaveBeenCalledWith({ startLine: 2, endLine: 2, label: 'Evidence' });
    expect(result.transcriptMessages).toHaveLength(2);
    expect(result.transcriptMessages[0]).toMatchObject({
      role: 'assistant',
      toolCalls: [expect.objectContaining({ id: 'call-1' })],
    });
    expect(result.transcriptMessages[1]).toEqual({
      role: 'tool',
      content: 'Highlighted lines 2-2.',
      toolCallId: 'call-1',
    });
    expect(send).toHaveBeenCalledTimes(2);
    const secondMessages = send.mock.calls[1][0].messages;
    expect(secondMessages.at(-1)).toEqual({
      role: 'tool',
      content: 'Highlighted lines 2-2.',
      toolCallId: 'call-1',
    });
    expect(secondMessages[0].role).toBe('system');
    expect(secondMessages[0].content).toContain(
      '<article lines="1-2">\n1: Intro.\n2: Evidence.\n</article>',
    );
    // The first request is an exact prefix of the tool-result follow-up, so
    // providers can reuse the source prefill/KV cache within the tool loop.
    expect(secondMessages.slice(0, send.mock.calls[0][0].messages.length)).toEqual(
      send.mock.calls[0][0].messages,
    );
  });

  it('skips an overlapping highlight instead of executing it again', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: 'call-2',
            name: 'highlight_span',
            arguments: { start_line: 3, end_line: 4 },
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, content: 'Already highlighted.' });
    const onHighlight = vi.fn();

    const result = await runArticleChatTurn({
      history: [],
      question: 'Show it',
      sentences: ['1', '2', '3', '4'],
      highlightedRanges: [{ startLine: 2, endLine: 3 }],
      onHighlight,
      send,
    });

    expect(onHighlight).not.toHaveBeenCalled();
    expect(result.highlightRanges).toEqual([]);
    expect(send.mock.calls[1][0].messages.at(-1).content).toContain('already highlighted');
  });

  it('does not mutate the highlightedRanges input', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: 'call-3',
            name: 'highlight_span',
            arguments: { start_line: 1, end_line: 1 },
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, content: 'Done.' });
    const highlightedRanges = [{ startLine: 3, endLine: 3 }];

    const result = await runArticleChatTurn({
      history: [],
      question: 'Highlight the intro',
      sentences: ['1', '2', '3'],
      highlightedRanges,
      send,
    });

    expect(highlightedRanges).toEqual([{ startLine: 3, endLine: 3 }]);
    expect(result.highlightRanges).toEqual([{ startLine: 1, endLine: 1, label: '' }]);
  });

  it('allows more than eight tool-call rounds for long articles by default', async () => {
    const send = vi.fn();
    for (let line = 1; line <= 9; line += 1) {
      send.mockResolvedValueOnce({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: `call-${line}`,
            name: 'highlight_span',
            arguments: { start_line: line, end_line: line },
          },
        ],
      });
    }
    send.mockResolvedValueOnce({ ok: true, content: 'Done.' });

    const result = await runArticleChatTurn({
      history: [],
      question: 'Highlight the article',
      sentences: Array.from({ length: 9 }, (_, index) => `Sentence ${index + 1}.`),
      send,
    });

    expect(result.reply).toBe('Done.');
    expect(result.highlightRanges).toHaveLength(9);
    expect(send).toHaveBeenCalledTimes(10);
  });

  it('processes large articles concurrently and synthesizes their findings', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, content: 'The opening establishes the premise.' })
      .mockResolvedValueOnce({ ok: true, content: 'The ending provides the outcome.' })
      .mockResolvedValueOnce({ ok: true, content: 'The premise leads to the stated outcome.' });

    const result = await runArticleChatTurn({
      history: [],
      question: 'What happens?',
      sentences: ['Opening premise.', 'Ending outcome.'],
      maxChunkChars: 20,
      send,
    });

    expect(result.reply).toBe('The premise leads to the stated outcome.');
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0][0].messages[0].content).toContain(
      '<article lines="1-1">\n1: Opening premise.\n</article>',
    );
    expect(send.mock.calls[1][0].messages[0].content).toContain(
      '<article lines="2-2">\n2: Ending outcome.\n</article>',
    );
    expect(send.mock.calls[2][0].tools).toBeUndefined();
    expect(send.mock.calls[2][0].messages[1].content).toContain(
      '<chunk_finding lines="1-1">\nThe opening establishes the premise.\n</chunk_finding>',
    );
  });

  it('tolerates an empty chunk when another chunk has findings', async () => {
    const send = vi.fn(async ({ messages, tools }) => {
      if (!tools) return { ok: true, content: 'Only the ending answers the question.' };
      const source = messages[0].content;
      return source.includes('lines="1-1"')
        ? { ok: true, content: '' }
        : { ok: true, content: 'The ending contains the answer.' };
    });

    const result = await runArticleChatTurn({
      history: [],
      question: 'Where is the answer?',
      sentences: ['Irrelevant opening.', 'Relevant ending.'],
      maxChunkChars: 24,
      send,
    });

    expect(result.reply).toBe('The ending contains the answer.');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('errors when every chunk response is empty', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: '' });

    await expect(
      runArticleChatTurn({
        history: [],
        question: 'What happens?',
        sentences: ['First.', 'Second.'],
        maxChunkChars: 10,
        send,
      }),
    ).rejects.toThrow('The LLM returned an empty response.');
  });

  it('starts independent chunks concurrently', async () => {
    const resolvers = [];
    const send = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const turn = runArticleChatTurn({
      history: [],
      question: 'Compare them',
      sentences: ['First.', 'Second.'],
      maxChunkChars: 10,
      send,
    });
    await Promise.resolve();

    expect(send).toHaveBeenCalledTimes(2);
    resolvers[0]({ ok: true, content: 'First finding.' });
    resolvers[1]({ ok: true, content: 'Second finding.' });
    for (let index = 0; index < 10 && send.mock.calls.length < 3; index += 1) {
      await Promise.resolve();
    }
    expect(send).toHaveBeenCalledTimes(3);
    resolvers[2]({ ok: true, content: 'Combined answer.' });
    await expect(turn).resolves.toMatchObject({ reply: 'Combined answer.' });
  });

  it('caps LLM calls across all chunks in a turn', async () => {
    const send = vi.fn().mockResolvedValue({
      ok: true,
      content: '',
      toolCalls: [{ name: 'highlight_span', arguments: { start_line: 1, end_line: 1 } }],
    });

    await expect(
      runArticleChatTurn({
        history: [],
        question: 'Highlight everything',
        sentences: ['First.', 'Second.'],
        maxChunkChars: 10,
        maxLlmRequests: 3,
        send,
      }),
    ).rejects.toThrow('turn-wide request limit');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('rejects a highlight outside the active chunk', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        content: '',
        toolCalls: [
          {
            id: 'out-of-chunk',
            name: 'highlight_span',
            arguments: { start_line: 2, end_line: 2 },
          },
        ],
      })
      .mockResolvedValueOnce({ ok: true, content: 'No evidence in this chunk.' })
      .mockResolvedValueOnce({ ok: true, content: 'Evidence is in the later chunk.' })
      .mockResolvedValueOnce({ ok: true, content: 'The later chunk has the evidence.' });

    const onHighlight = vi.fn();
    const result = await runArticleChatTurn({
      history: [],
      question: 'Where is it?',
      sentences: ['First.', 'Second.'],
      maxChunkChars: 10,
      onHighlight,
      send,
    });

    expect(onHighlight).not.toHaveBeenCalled();
    expect(result.highlightRanges).toEqual([]);
    const retryCall = send.mock.calls.find(([request]) =>
      request.messages.at(-1)?.content?.includes('must stay within the supplied lines 1-1'),
    );
    expect(retryCall).toBeDefined();
  });

  it('keeps conversational history but omits prior tool transcripts', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: 'Answer.' });
    const history = [
      { role: 'user', content: 'Q1' },
      // Tool transcripts are persisted for auditability, but are not useful
      // context for every source chunk on later turns.
      { role: 'assistant', content: '', toolCalls: [{ id: 'ok-1', name: 'highlight_span' }] },
      { role: 'tool', content: 'Highlighted lines 1-1.', toolCallId: 'ok-1' },
      { role: 'assistant', content: 'A1' },
      // Dangling tool call (persisted by the old scheme before a failure): dropped.
      { role: 'assistant', content: '', toolCalls: [{ id: 'lost-1', name: 'highlight_span' }] },
      { role: 'user', content: 'Q2' },
      // Orphan tool result with no matching preceding call: dropped.
      { role: 'tool', content: 'stray', toolCallId: 'stray-1' },
      { role: 'assistant', content: 'A2' },
    ];

    await runArticleChatTurn({
      history,
      question: 'Q3',
      sentences: ['One.'],
      send,
    });

    const sent = send.mock.calls[0][0].messages;
    expect(sent.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(sent.some((message) => message.role === 'tool' || message.toolCalls)).toBe(false);
    expect(sent.some((message) => message.content === 'stray')).toBe(false);
    expect(sent.some((message) => message.toolCalls?.some((call) => call.id === 'lost-1'))).toBe(
      false,
    );
  });
});

describe('article chat tool-call outcome metrics', () => {
  // Two-round send: first returns the given tool call, second ends the turn.
  function sendWithToolCall(toolCall) {
    return vi
      .fn()
      .mockResolvedValueOnce({ ok: true, content: '', toolCalls: [{ id: 'c1', ...toolCall }] })
      .mockResolvedValueOnce({ ok: true, content: 'Done.' });
  }

  async function runWith({ toolCall, sentences = ['One.', 'Two.', 'Three.'], onHighlight }) {
    const recordToolMetric = vi.fn();
    const result = await runArticleChatTurn({
      history: [],
      question: 'Q',
      sentences,
      onHighlight,
      send: sendWithToolCall(toolCall),
      recordToolMetric,
    });
    return { recordToolMetric, result };
  }

  it('records an accepted highlight as "highlighted"', async () => {
    const { recordToolMetric, result } = await runWith({
      toolCall: { name: 'highlight_span', arguments: { start_line: 1, end_line: 1 } },
    });
    expect(recordToolMetric).toHaveBeenCalledWith({ outcome: 'highlighted', error: undefined });
    expect(result.highlightRanges).toEqual([{ startLine: 1, endLine: 1, label: '' }]);
  });

  it('records an unknown tool as "unknown_tool" without persisting the model-supplied name', async () => {
    const { recordToolMetric } = await runWith({
      toolCall: { name: 'frobnicate', arguments: {} },
    });
    // The model-generated tool name may echo article text, so it must not be
    // persisted as a metric detail (only the stable outcome is recorded).
    expect(recordToolMetric).toHaveBeenCalledWith({ outcome: 'unknown_tool', error: undefined });
  });

  it('records non-integer arguments as "invalid_arguments"', async () => {
    const { recordToolMetric } = await runWith({
      toolCall: { name: 'highlight_span', arguments: { start_line: 'x', end_line: 2 } },
    });
    expect(recordToolMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'invalid_arguments' }),
    );
  });

  it('records a range past the article end as "out_of_range"', async () => {
    const { recordToolMetric } = await runWith({
      toolCall: { name: 'highlight_span', arguments: { start_line: 1, end_line: 99 } },
    });
    expect(recordToolMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'out_of_range' }),
    );
  });

  it('records a range outside the active chunk as "out_of_chunk"', async () => {
    // Small chunks so line 3 falls outside the first chunk's visible lines
    // (it is a valid article line, but not in the chunk the model was shown).
    const recordToolMetric = vi.fn();
    await runArticleChatTurn({
      history: [],
      question: 'Q',
      sentences: ['First.', 'Second.', 'Third.'],
      maxChunkChars: 10,
      send: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          content: '',
          toolCalls: [
            { id: 'c1', name: 'highlight_span', arguments: { start_line: 3, end_line: 3 } },
          ],
        })
        .mockResolvedValue({ ok: true, content: 'Done.' }),
      recordToolMetric,
    });
    expect(recordToolMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'out_of_chunk' }),
    );
  });

  it('records an already-highlighted range as "overlap_skipped"', async () => {
    const recordToolMetric = vi.fn();
    await runArticleChatTurn({
      history: [],
      question: 'Q',
      sentences: ['One.', 'Two.', 'Three.'],
      highlightedRanges: [{ startLine: 1, endLine: 1 }],
      send: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          content: '',
          toolCalls: [{ id: 'c1', name: 'highlight_span', arguments: { start_line: 1, end_line: 1 } }],
        })
        .mockResolvedValueOnce({ ok: true, content: 'Done.' }),
      recordToolMetric,
    });
    expect(recordToolMetric).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'overlap_skipped' }),
    );
  });

  it('commits the range but records "paint_failed" when live painting throws', async () => {
    const onHighlight = vi.fn().mockRejectedValue(new Error('canvas gone'));
    const { recordToolMetric, result } = await runWith({
      toolCall: { name: 'highlight_span', arguments: { start_line: 2, end_line: 2 } },
      onHighlight,
    });
    // Paint failure must not drop the range or report an error to the model.
    expect(result.highlightRanges).toEqual([{ startLine: 2, endLine: 2, label: '' }]);
    expect(result.transcriptMessages.find((m) => m.role === 'tool')?.content).toBe(
      'Highlighted lines 2-2.',
    );
    expect(recordToolMetric).toHaveBeenCalledWith({
      outcome: 'paint_failed',
      error: 'canvas gone',
    });
  });
});
