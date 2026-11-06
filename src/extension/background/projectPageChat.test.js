import { describe, it, expect, vi } from 'vitest';
import { MAX_PAGE_TEXT_CHARS, createProjectPageChatService } from './projectPageChat.js';

const TEXT =
  'Cats sleep for most of the day in warm places. They wake up at dusk to hunt small prey.';

function makeService({ tabs, records = {}, reply } = {}) {
  const projectService = {
    getProjectView: vi.fn(async () => ({ tabs: tabs || [] })),
  };
  const findRecordByUrl = vi.fn(async (url) => records[url] || null);
  const sendTabMessage = vi.fn(async () => reply ?? { status: 'ok', text: TEXT });
  return {
    service: createProjectPageChatService({ projectService, findRecordByUrl, sendTabMessage }),
    projectService,
    findRecordByUrl,
    sendTabMessage,
  };
}

describe('project page chat service', () => {
  it('uses the saved record for a tab whose URL has one', async () => {
    const record = {
      key: 'rec-1',
      sentences: ['One.'],
      topics: [{ name: 'A', sentences: [1] }],
      contentRevision: 'rev-1',
    };
    const { service, projectService } = makeService({
      tabs: [{ id: 4, url: 'https://a.test/post' }],
      records: { 'https://a.test/post': record },
    });
    expect(await service.getPageChat('p1', 4)).toEqual({
      kind: 'record',
      key: 'rec-1',
      url: 'https://a.test/post',
      sentences: ['One.'],
      topics: record.topics,
      contentRevision: 'rev-1',
    });
    expect(projectService.getProjectView).toHaveBeenCalledWith('p1');
  });

  it('falls back to the URL without its fragment when matching records', async () => {
    const { service, findRecordByUrl } = makeService({
      tabs: [{ id: 4, url: 'https://a.test/post#intro' }],
      records: { 'https://a.test/post': { key: 'rec-1', sentences: [], topics: [] } },
    });
    const source = await service.getPageChat('p1', 4);
    expect(source).toMatchObject({ kind: 'record', key: 'rec-1', sentences: [] });
    expect(findRecordByUrl.mock.calls.map(([url]) => url)).toEqual([
      'https://a.test/post#intro',
      'https://a.test/post',
    ]);
  });

  it('gives an unsaved page its own URL-scoped key', async () => {
    const { service } = makeService({ tabs: [{ id: 4, url: 'https://a.test/post#x' }] });
    expect(await service.getPageChat('p1', 4)).toEqual({
      kind: 'page',
      key: 'page:https://a.test/post',
      url: 'https://a.test/post',
    });
  });

  it('reports browser-internal pages as unsupported and rejects foreign tabs', async () => {
    const { service } = makeService({ tabs: [{ id: 4, url: 'chrome://settings' }] });
    expect(await service.getPageChat('p1', 4)).toMatchObject({ kind: 'unsupported' });
    await expect(service.getPageChat('p1', 99)).rejects.toThrow('tab is not in this project');
    await expect(service.capturePageText('p1', 4)).rejects.toThrow('not available');
  });

  it('captures and splits live tab text', async () => {
    const { service, sendTabMessage } = makeService({ tabs: [{ id: 4, url: 'https://a.test/' }] });
    const result = await service.capturePageText('p1', 4);
    expect(sendTabMessage).toHaveBeenCalledWith(4, { action: 'capturePageText' });
    expect(result.truncated).toBe(false);
    expect(result.sentences.join(' ')).toContain('Cats sleep');
    expect(result.sentences.length).toBeGreaterThan(0);
  });

  it('bounds the captured text', async () => {
    const { service } = makeService({
      tabs: [{ id: 4, url: 'https://a.test/' }],
      reply: { status: 'ok', text: `${TEXT} `.repeat(MAX_PAGE_TEXT_CHARS / 40) },
    });
    const result = await service.capturePageText('p1', 4);
    expect(result.truncated).toBe(true);
    expect(result.sentences.join(' ').length).toBeLessThanOrEqual(MAX_PAGE_TEXT_CHARS);
  });

  it('explains unreachable tabs and empty pages', async () => {
    const tabs = [{ id: 4, url: 'https://a.test/' }];
    const unreachable = makeService({ tabs });
    unreachable.sendTabMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(unreachable.service.capturePageText('p1', 4)).rejects.toThrow(
      'Could not read this tab',
    );
    const empty = makeService({ tabs, reply: { status: 'ok', text: '   ' } });
    await expect(empty.service.capturePageText('p1', 4)).rejects.toThrow('No readable text');
    const failed = makeService({ tabs, reply: { status: 'error', error: 'boom' } });
    await expect(failed.service.capturePageText('p1', 4)).rejects.toThrow('boom');
  });
});
