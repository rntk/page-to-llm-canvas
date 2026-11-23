import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createChromeStorageFake } from '../../../test/fakes/chromeStorageFake.mjs';
import {
  _resetUpdateQueues,
  putRecordTopicTagClouds,
  readRecordView,
  updateRecord,
  writeRecord,
} from '../../core/storage/storage.js';
import { TOPIC_SOURCE } from '../../shared/runtime/topicSources.js';
import { createTopicTagCloudService } from './topicTagCloudService.js';

const provider = { token: 'secret-token' };
const record = {
  key: 'saved',
  sourceUrl: 'https://example.com/',
  status: 'done',
  pipelineRunId: 'run',
  text: 'Orchid.',
  sentences: ['Orchid.'],
  topics: [{ name: 'Plants > Flowers', sentences: [1] }],
  summary_tree: {
    version: 1,
    status: 'done',
    updatedAt: 2,
    rootId: 'root',
    nodes: {
      root: { id: 'root', children: ['leaf'] },
      leaf: { id: 'leaf', kind: 'passage', title: 'Passage', sentences: [1] },
    },
  },
};

function answerAll(_state, questions) {
  return {
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [id, { probabilities: { yes: 0.9 } }]),
    ),
  };
}

function setup(decide = vi.fn(async (...args) => answerAll(...args))) {
  const getTagCloudProvider = vi.fn(async () => provider);
  const service = createTopicTagCloudService({
    readRecordView,
    putRecordTopicTagClouds,
    getTagCloudProvider,
    bindDecide: () => decide,
  });
  return { decide, getTagCloudProvider, service };
}

beforeEach(async () => {
  _resetUpdateQueues();
  vi.stubGlobal('chrome', createChromeStorageFake());
  await writeRecord(record);
});

describe('topic tag cloud service', () => {
  it('shares matching requests and persists independent caches for both topic sources', async () => {
    const { decide, service } = setup();
    const [pipeline, concurrent, summary] = await Promise.all([
      service.get(record.key, TOPIC_SOURCE.PIPELINE),
      service.get(record.key, TOPIC_SOURCE.PIPELINE),
      service.get(record.key, TOPIC_SOURCE.SUMMARY_TREE),
    ]);
    const tags = [{ word: 'Orchid', weight: 0.9 }];
    expect(pipeline.byPath).toEqual({ Plants: tags, 'Plants>Flowers': tags });
    expect(concurrent).toEqual(pipeline);
    expect(summary.byPath).toEqual({ Passage: tags });
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[0][2].taskType).toBe('topic_tags');

    const next = setup();
    expect(await next.service.get(record.key, TOPIC_SOURCE.PIPELINE)).toEqual(pipeline);
    expect(await next.service.get(record.key, TOPIC_SOURCE.SUMMARY_TREE)).toEqual(summary);
    expect(next.getTagCloudProvider).not.toHaveBeenCalled();
  });

  it('rejects a result from before a resplit and generates tags for the new path', async () => {
    const { decide, service } = setup();
    decide.mockImplementationOnce(async (...args) => {
      await updateRecord(record.key, { topics: [{ name: 'Garden', sentences: [1] }] });
      return answerAll(...args);
    });

    await expect(service.get(record.key, TOPIC_SOURCE.PIPELINE)).rejects.toThrow(
      'The topics changed',
    );
    expect((await readRecordView(record.key)).topic_tag_clouds).toBeUndefined();
    const current = await service.get(record.key, TOPIC_SOURCE.PIPELINE);
    expect(current.byPath).toEqual({ Garden: [{ word: 'Orchid', weight: 0.9 }] });
    expect(current.contentRevision).toBe((await readRecordView(record.key)).contentRevision);
  });

  it('does not share work across replacements of a legacy summary tree', async () => {
    const saved = await readRecordView(record.key);
    const { updatedAt: _updatedAt, ...legacyTree } = saved.summary_tree;
    const { decide, service } = setup();
    await updateRecord(record.key, { summary_tree: legacyTree });
    decide.mockImplementationOnce(async (...args) => {
      const leaf = { ...legacyTree.nodes.leaf, title: 'Replacement' };
      await updateRecord(record.key, {
        summary_tree: { ...legacyTree, nodes: { ...legacyTree.nodes, leaf } },
      });
      const replacement = await service.get(record.key, TOPIC_SOURCE.SUMMARY_TREE);
      expect(replacement.byPath).toHaveProperty('Replacement');
      return answerAll(...args);
    });

    await expect(service.get(record.key, TOPIC_SOURCE.SUMMARY_TREE)).rejects.toThrow(
      'The topics changed',
    );
    expect(decide).toHaveBeenCalledTimes(2);
    expect((await readRecordView(record.key)).topic_tag_clouds).toBeUndefined();
  });

  it('allows retry after failing and scrubs provider credentials', async () => {
    const { decide, getTagCloudProvider, service } = setup();
    getTagCloudProvider.mockResolvedValueOnce(null);
    decide.mockRejectedValueOnce(new Error('Failed with secret-token'));

    await expect(service.get(record.key, TOPIC_SOURCE.PIPELINE)).rejects.toThrow('in Options');
    await expect(service.get(record.key, TOPIC_SOURCE.PIPELINE)).rejects.toThrow(
      'Failed with [redacted]',
    );
    await expect(service.get(record.key, TOPIC_SOURCE.PIPELINE)).resolves.toHaveProperty(
      'byPath.Plants',
    );
  });
});
