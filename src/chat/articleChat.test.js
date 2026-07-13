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

  it('executes highlights, returns tool results, then yields the final reply', async () => {
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
    const onTranscriptMessage = vi.fn();

    const result = await runArticleChatTurn({
      history: [{ role: 'user', content: 'Earlier question' }],
      question: 'Where is the evidence?',
      sentences: ['Intro.', 'Evidence.'],
      onHighlight,
      onTranscriptMessage,
      send,
    });

    expect(result.reply).toBe('The second sentence is the evidence.');
    expect(onHighlight).toHaveBeenCalledWith({ startLine: 2, endLine: 2, label: 'Evidence' });
    expect(onTranscriptMessage).toHaveBeenCalledTimes(2);
    expect(onTranscriptMessage.mock.calls[0][0]).toMatchObject({
      role: 'assistant',
      toolCalls: [expect.objectContaining({ id: 'call-1' })],
    });
    expect(onTranscriptMessage.mock.calls[1][0]).toEqual({
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

    await runArticleChatTurn({
      history: [],
      question: 'Show it',
      sentences: ['1', '2', '3', '4'],
      highlightedRanges: [{ startLine: 2, endLine: 3 }],
      onHighlight,
      send,
    });

    expect(onHighlight).not.toHaveBeenCalled();
    expect(send.mock.calls[1][0].messages.at(-1).content).toContain('already highlighted');
  });
});
