import { describe, expect, it, vi } from 'vitest';
import { addNode, PASSAGE } from './summaryTreeModel.js';
import { buildTopics, placeTopics } from './summaryTreeTopics.js';
import { createSummaryTreeLlm } from './summaryTreeRequests.js';

describe('topic tree construction', () => {
  it('keeps a small set of passages directly under the root without a model request', async () => {
    const nodes = {};
    const ids = [1, 2].map((n) => addNode(nodes, PASSAGE, `P${n}`, [], { sentences: [n] }));
    const askDecoded = vi.fn();
    const root = await buildTopics({
      nodes,
      passageIds: ids,
      rootTitle: 'Article',
      llm: { askDecoded },
    });
    expect(nodes[root].children).toEqual(ids);
    expect(askDecoded).not.toHaveBeenCalled();
  });

  it('invalidates summaries only along the path where a new passage is attached', async () => {
    const nodes = {};
    const old = addNode(nodes, PASSAGE, 'Old', [], { sentences: [1] });
    const leaf = addNode(nodes, 'topic', 'Leaf', [old]);
    const branch = addNode(nodes, 'topic', 'Branch', [leaf]);
    const sibling = addNode(nodes, 'topic', 'Sibling', []);
    const root = addNode(nodes, 'root', 'Root', [branch, sibling]);
    const added = addNode(nodes, PASSAGE, 'New', [], { sentences: [3, 2] });
    nodes[added].unplaced = true;
    for (const id of [root, branch, leaf, sibling])
      nodes[id].segments = [{ text: 'Saved', sources: [] }];
    const callLLMWithRetry = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ topics: [{ title: 'Branch', passages: ['P1'] }] }))
      .mockResolvedValueOnce(JSON.stringify({ topics: [{ title: 'Leaf', passages: ['P1'] }] }));
    await placeTopics({
      nodes,
      rootId: root,
      unitIds: [added],
      llm: createSummaryTreeLlm({ callLLMWithRetry }),
    });
    expect(nodes[leaf].children).toEqual([old, added]);
    for (const id of [root, branch, leaf]) {
      expect(nodes[id].segments).toBeNull();
      expect(nodes[id].sentences).toEqual([1, 2, 3]);
    }
    expect(nodes[sibling].segments).toEqual([{ text: 'Saved', sources: [] }]);
    expect(nodes[added].unplaced).toBe(false);
  });
});
