import { describe, it, expect, vi } from 'vitest';
import { summarizeTopicTree } from './topicTreeMerge.js';
import { buildTopicTree } from './orchestrator.js';

describe('summarizeTopicTree', () => {
  it('uses the leaf summary for a leaf node without calling summarizeSource', async () => {
    // One top-level topic with no children: its precomputed per-topic summary is
    // used as-is; no source-based summary is generated.
    const topics = [{ name: 'A', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { A: { text: 'Summary A' } },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index.A).toEqual({ text: 'Summary A', level: 0, source_sentences: [1, 2] });
    // The empty root path is excluded.
    expect(Object.keys(index)).toEqual(['A']);
  });

  it('summarizes an internal node from its own source sentences, not its children', async () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1, 2] },
      { name: 'Tech>HW', sentences: [3, 4] },
    ];
    const { nodes } = buildTopicTree(topics);

    const calls = [];
    const summarizeSource = vi.fn(async (sourceSentenceIds, info) => {
      calls.push({ ids: sourceSentenceIds, path: info.path });
      return { text: 'Tech from source' };
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': { text: 'AI leaf' },
        'Tech>HW': { text: 'HW leaf' },
      },
      summarizeSource,
    });

    // Only the internal node (Tech) is summarized from source; the leaves reuse
    // their per-topic summaries. (Root is skipped — Tech is its single child.)
    expect(calls).toEqual([{ ids: [1, 2, 3, 4], path: 'Tech' }]);
    expect(index['Tech']).toEqual({
      text: 'Tech from source',
      level: 0,
      source_sentences: [1, 2, 3, 4],
    });
    expect(index['Tech>AI']).toEqual({ text: 'AI leaf', level: 1, source_sentences: [1, 2] });
    expect(index['Tech>HW']).toEqual({ text: 'HW leaf', level: 1, source_sentences: [3, 4] });
  });

  it('never summarizes the empty root path, even with multiple top-level domains', async () => {
    // Each domain has two children so it is a genuine summarize-from-source
    // anchor (not a delegating single-child node); this keeps the root-skip
    // assertion independent of the passthrough path.
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'Tech>HW', sentences: [2] },
      { name: 'Sci>Bio', sentences: [3] },
      { name: 'Sci>Phys', sentences: [4] },
    ];
    const { nodes } = buildTopicTree(topics);

    const seenPaths = [];
    const summarizeSource = vi.fn(async (ids, info) => {
      seenPaths.push(info.path);
      return { text: `src ${info.path}` };
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': { text: 'ai' },
        'Tech>HW': { text: 'hw' },
        'Sci>Bio': { text: 'bio' },
        'Sci>Phys': { text: 'phys' },
      },
      summarizeSource,
    });

    // Tech and Sci are summarized from source; the root, which would re-summarize
    // the whole document, is never touched.
    expect(seenPaths.sort()).toEqual(['Sci', 'Tech']);
    expect(index['Tech'].text).toBe('src Tech');
    expect(index['Sci'].text).toBe('src Sci');
    expect(index['']).toBeUndefined();
  });

  it('delegates a single-child node to its child summary instead of regenerating', async () => {
    // root>Tech>AI, AI a leaf. Tech has one child whose source is identical, so
    // Tech reuses AI's per-topic summary rather than calling summarizeSource.
    const topics = [{ name: 'Tech>AI', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI': { text: 'AI leaf' } },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index['Tech'].text).toBe('AI leaf');
    expect(index['Tech>AI'].text).toBe('AI leaf');
  });

  it('delegates down a multi-level single-child chain to the deepest leaf anchor', async () => {
    // Tech>AI>LLM with LLM the only leaf: AI and Tech both cover exactly LLM's
    // sentences, so both delegate down to LLM's stored summary; no LLM call.
    const topics = [{ name: 'Tech>AI>LLM', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI>LLM': { text: 'llm leaf' } },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index['Tech'].text).toBe('llm leaf');
    expect(index['Tech>AI'].text).toBe('llm leaf');
    expect(index['Tech>AI>LLM'].text).toBe('llm leaf');
  });

  it('summarizes a single-child node from source when it owns sentences beyond its child', async () => {
    // Tech>AI is assigned its own sentence [5] AND has a child Tech>AI>LLM ([1,2]).
    // AI's source ([1,2,5]) is a superset of LLM's, so AI must NOT delegate — it
    // is summarized from source. Tech (one child, identical source to AI) still
    // delegates to AI's generated summary.
    const topics = [
      { name: 'Tech>AI', sentences: [5] },
      { name: 'Tech>AI>LLM', sentences: [1, 2] },
    ];
    const { nodes } = buildTopicTree(topics);

    const calls = [];
    const summarizeSource = vi.fn(async (ids, info) => {
      calls.push({ ids, path: info.path });
      return { text: 'AI from source' };
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI>LLM': { text: 'llm leaf' } },
      summarizeSource,
    });

    // summarizeSource runs once, for AI, over AI's full aggregated source.
    expect(calls).toEqual([{ ids: [1, 2, 5], path: 'Tech>AI' }]);
    expect(index['Tech>AI'].text).toBe('AI from source');
    expect(index['Tech'].text).toBe('AI from source');
    expect(index['Tech>AI>LLM'].text).toBe('llm leaf');
  });

  it('on summarizeSource failure calls onError and falls back to empty text', async () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'Tech>HW', sentences: [2] },
    ];
    const { nodes } = buildTopicTree(topics);
    const onError = vi.fn();
    const boom = new Error('summary boom');
    const summarizeSource = vi.fn(async () => {
      throw boom;
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI': { text: 'a' }, 'Tech>HW': { text: 'b' } },
      summarizeSource,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ path: 'Tech', error: boom });
    expect(index['Tech'].text).toBe('');
    // Leaves are unaffected by the internal-node failure.
    expect(index['Tech>AI'].text).toBe('a');
  });

  it('falls back to empty text for a leaf with no stored summary', async () => {
    const topics = [{ name: 'A', sentences: [1] }];
    const { nodes } = buildTopicTree(topics);

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {},
      summarizeSource: vi.fn(),
    });

    expect(index.A).toEqual({ text: '', level: 0, source_sentences: [1] });
  });
});
