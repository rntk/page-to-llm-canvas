import { describe, expect, it, vi } from 'vitest';
import { buildNumberedArticle, rangesOverlap, runArticleChatTurn } from './articleChat.js';

describe('article chat tool loop', () => {
  it('numbers article sentences', () => {
    expect(buildNumberedArticle(['First.', 'Second.'])).toBe('1: First.\n2: Second.');
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
    expect(secondMessages[2].content).toContain('<article>\n1: Intro.\n2: Evidence.\n</article>');
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

  it('drops dangling tool calls and orphan tool results from history', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, content: 'Answer.' });
    const history = [
      { role: 'user', content: 'Q1' },
      // Well-formed pair: kept.
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
    expect(sent.map((message) => [message.role, message.toolCallId ?? null])).toEqual([
      ['system', null],
      ['user', null],
      ['assistant', null],
      ['tool', 'ok-1'],
      ['assistant', null],
      ['user', null],
      ['assistant', null],
      ['user', null],
    ]);
    expect(sent.some((message) => message.content === 'stray')).toBe(false);
    expect(sent.some((message) => message.toolCalls?.some((call) => call.id === 'lost-1'))).toBe(
      false,
    );
  });
});
