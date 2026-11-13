import { describe, it, expect, vi } from 'vitest';
import { createProjectPageChatService } from './projectPageChat.js';

const TEXT = 'Cats sleep for most of the day. They wake up at dusk to hunt.';

function makeService({ tabs = [], records = {} } = {}) {
  const projectService = { getProjectView: vi.fn(async () => ({ tabs })) };
  const findRecordByUrl = vi.fn(async (url) => records[url] || null);
  const sendTabMessage = vi.fn(async () => ({ status: 'ok', text: TEXT }));
  return {
    service: createProjectPageChatService({ projectService, findRecordByUrl, sendTabMessage }),
    sendTabMessage,
  };
}

describe('readPageText', () => {
  it('prefers the saved record’s sentences', async () => {
    const { service, sendTabMessage } = makeService({
      records: { 'https://a.test/post': { key: 'r', sentences: ['One.', 'Two.'] } },
    });
    expect(await service.readPageText('p1', 'https://a.test/post#x')).toEqual({
      sentences: ['One.', 'Two.'],
      truncated: false,
      source: 'record',
      topics: [],
    });
    expect(sendTabMessage).not.toHaveBeenCalled();
  });

  it('lists the record topic names, capped and clipped', async () => {
    const topics = [
      { name: 'x'.repeat(200), sentences: [1] },
      { name: '  ' },
      { sentences: [2] },
      ...Array.from({ length: 60 }, (_, i) => ({ name: `Topic ${i}` })),
    ];
    const { service } = makeService({
      records: { 'https://a.test/post': { key: 'r', sentences: ['One.'], topics } },
    });
    const result = await service.readPageText('p1', 'https://a.test/post');
    expect(result.topics).toHaveLength(40);
    expect(result.topics[0]).toBe('x'.repeat(120));
    expect(result.topics[1]).toBe('Topic 0');
  });

  it('reads a project tab showing the page when it is not saved', async () => {
    const { service, sendTabMessage } = makeService({
      tabs: [{ id: 9, url: 'https://a.test/post#top' }],
    });
    const result = await service.readPageText('p1', 'https://a.test/post');
    expect(result.source).toBe('tab');
    expect(result.topics).toEqual([]);
    expect(result.sentences.length).toBeGreaterThan(0);
    expect(sendTabMessage).toHaveBeenCalledWith(9, { action: 'capturePageText' });
  });

  it('explains when the page is neither saved nor open', async () => {
    const { service } = makeService();
    await expect(service.readPageText('p1', 'https://a.test/post')).rejects.toThrow(
      /not open in this project/,
    );
    await expect(service.readPageText('p1', 'chrome://settings')).rejects.toThrow(/not available/);
  });
});
