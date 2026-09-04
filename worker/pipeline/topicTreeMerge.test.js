import { describe, it, expect, vi } from 'vitest';
import {
  buildPartialTopicSummaryIndex,
  buildTopicTree,
  summarizeTopicTree,
} from './topicTreeMerge.js';

// Summaries are per contiguous run: { runs: [{ sentences, text }] }. A leaf with a
// single run is the common case; internal nodes return whatever runs
// summarizeSource produces.
const oneRun = (sentences, text) => ({ runs: [{ sentences, text }] });

describe('buildTopicTree', () => {
  it('builds a deep path from strictly shorter parent prefixes', () => {
    const { root, nodes } = buildTopicTree([{ name: 'Domain>Section>Leaf', sentences: [3] }]);

    expect([...nodes.keys()]).toEqual(['', 'Domain', 'Domain>Section', 'Domain>Section>Leaf']);
    expect(root.children.map((node) => node.path)).toEqual(['Domain']);
    expect(nodes.get('Domain').children.map((node) => node.path)).toEqual(['Domain>Section']);
    expect(nodes.get('Domain>Section').children.map((node) => node.path)).toEqual([
      'Domain>Section>Leaf',
    ]);
  });

  it('merges sentences from duplicate topic paths', () => {
    const { nodes } = buildTopicTree([
      { name: 'A>B', sentences: [1, 2] },
      { name: 'A>B', sentences: [4, 2] },
    ]);

    expect(nodes.get('A>B').sourceSentences).toEqual([1, 2, 4]);
    expect(nodes.get('A').sourceSentences).toEqual([1, 2, 4]);
  });
});

describe('buildPartialTopicSummaryIndex', () => {
  it('projects available leaf checkpoints into the canonical index shape', () => {
    const index = buildPartialTopicSummaryIndex(
      [
        { name: 'Tech>AI', sentences: [1, 2] },
        { name: 'Tech>Hardware', sentences: [3] },
      ],
      {
        'Tech>AI': {
          runs: [{ sentences: [1, 2], text: 'AI summary.' }],
          source_sentences: [1, 2],
        },
        'Tech>Hardware': {
          runs: [{ sentences: [3], text: '' }],
          source_sentences: [3],
          error: true,
        },
      },
    );

    expect(index).toEqual({
      'Tech>AI': {
        runs: [{ sentences: [1, 2], text: 'AI summary.' }],
        level: 1,
        source_sentences: [1, 2],
      },
      'Tech>Hardware': {
        runs: [{ sentences: [3], text: '' }],
        level: 1,
        source_sentences: [3],
      },
    });
  });
});

describe('summarizeTopicTree', () => {
  it('uses the leaf summary for a leaf node without calling summarizeSource', async () => {
    // One top-level topic with no children: its precomputed per-topic runs are
    // used as-is; no source-based summary is generated.
    const topics = [{ name: 'A', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { A: oneRun([1, 2], 'Summary A') },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index.A).toEqual({
      runs: [{ sentences: [1, 2], text: 'Summary A' }],
      level: 0,
      source_sentences: [1, 2],
    });
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
      return oneRun(sourceSentenceIds, 'Tech from source');
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': oneRun([1, 2], 'AI leaf'),
        'Tech>HW': oneRun([3, 4], 'HW leaf'),
      },
      summarizeSource,
    });

    // Only the internal node (Tech) is summarized from source; the leaves reuse
    // their per-topic summaries. (Root is skipped — Tech is its single child.)
    expect(calls).toEqual([{ ids: [1, 2, 3, 4], path: 'Tech' }]);
    expect(index['Tech']).toEqual({
      runs: [{ sentences: [1, 2, 3, 4], text: 'Tech from source' }],
      level: 0,
      source_sentences: [1, 2, 3, 4],
    });
    expect(index['Tech>AI']).toEqual({
      runs: [{ sentences: [1, 2], text: 'AI leaf' }],
      level: 1,
      source_sentences: [1, 2],
    });
    expect(index['Tech>HW']).toEqual({
      runs: [{ sentences: [3, 4], text: 'HW leaf' }],
      level: 1,
      source_sentences: [3, 4],
    });
  });

  it('reuses each child summary for a non-adjacent run owned by a single child', async () => {
    // Tech aggregates two non-adjacent occurrences, each wholly one child:
    // [1,2] is exactly Tech>AI and [10,11] is exactly Tech>HW. Neither run mixes
    // subtopics, so both reuse their child's summary and summarizeSource is never
    // called — we do not re-summarize text a subtopic already covers.
    const topics = [
      { name: 'Tech>AI', sentences: [1, 2] },
      { name: 'Tech>HW', sentences: [10, 11] },
    ];
    const { nodes } = buildTopicTree(topics);

    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': oneRun([1, 2], 'AI leaf'),
        'Tech>HW': oneRun([10, 11], 'HW leaf'),
      },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index['Tech'].runs).toEqual([
      { sentences: [1, 2], text: 'AI leaf' },
      { sentences: [10, 11], text: 'HW leaf' },
    ]);
  });

  it('reuses a successful same-path run when a sibling run failed', async () => {
    const topics = [
      { name: 'Tech', sentences: [2, 6] },
      { name: 'Tech>AI', sentences: [1, 5] },
    ];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn(async (ids) => oneRun(ids, 'fresh failed-run replacement'));

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        Tech: oneRun([2, 6], 'tech own source'),
        'Tech>AI': oneRun([1, 5], 'ai leaf'),
      },
      previousSummaryIndex: {
        Tech: {
          runs: [
            { sentences: [1, 2], text: 'keep successful run' },
            { sentences: [5, 6], text: '', error: true },
          ],
          source_sentences: [1, 2, 5, 6],
          error: true,
        },
      },
      reusePriorSummaries: true,
      summarizeSource,
    });

    expect(summarizeSource).toHaveBeenCalledWith([5, 6], { path: 'Tech' });
    expect(index.Tech.runs).toEqual([
      { sentences: [1, 2], text: 'keep successful run' },
      { sentences: [5, 6], text: 'fresh failed-run replacement' },
    ]);
  });

  it('keeps an unaffected ancestor run when a descendant run failed', async () => {
    const topics = [
      { name: 'Tech', sentences: [1] },
      { name: 'Tech>AI', sentences: [5] },
    ];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        Tech: oneRun([1], 'tech own leaf'),
        'Tech>AI': {
          runs: [{ sentences: [5], text: '', error: true }],
          error: true,
        },
      },
      previousSummaryIndex: {
        Tech: {
          runs: [
            { sentences: [1], text: 'keep unaffected ancestor run' },
            { sentences: [5], text: '', error: true },
          ],
          source_sentences: [1, 5],
        },
        'Tech>AI': {
          runs: [{ sentences: [5], text: '', error: true }],
          source_sentences: [5],
          error: true,
        },
      },
      reusePriorSummaries: true,
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index.Tech.runs).toEqual([
      { sentences: [1], text: 'keep unaffected ancestor run' },
      { sentences: [5], text: '' },
    ]);
  });

  it('does not reuse a mixed-child ancestor run when one leaf failure was accepted', async () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'Tech>HW', sentences: [2] },
    ];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn(async (ids) => oneRun(ids, 'fresh safe ancestor'));

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': {
          runs: [{ sentences: [1], text: '', acceptedFailure: true }],
          acceptedFailure: true,
        },
        'Tech>HW': oneRun([2], 'hardware leaf'),
      },
      previousSummaryIndex: {
        Tech: {
          runs: [{ sentences: [1, 2], text: 'stale ancestor' }],
          source_sentences: [1, 2],
        },
      },
      reusePriorSummaries: true,
      summarizeSource,
    });

    expect(summarizeSource).toHaveBeenCalledWith([1, 2], { path: 'Tech' });
    expect(index.Tech.runs).toEqual([{ sentences: [1, 2], text: 'fresh safe ancestor' }]);
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
      return oneRun(ids, `src ${info.path}`);
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {
        'Tech>AI': oneRun([1], 'ai'),
        'Tech>HW': oneRun([2], 'hw'),
        'Sci>Bio': oneRun([3], 'bio'),
        'Sci>Phys': oneRun([4], 'phys'),
      },
      summarizeSource,
    });

    // Tech and Sci are summarized from source; the root, which would re-summarize
    // the whole document, is never touched.
    expect(seenPaths.sort()).toEqual(['Sci', 'Tech']);
    expect(index['Tech'].runs[0].text).toBe('src Tech');
    expect(index['Sci'].runs[0].text).toBe('src Sci');
    expect(index['']).toBeUndefined();
  });

  it('delegates a single-child node to its child summary instead of regenerating', async () => {
    // root>Tech>AI, AI a leaf. Tech has one child whose source is identical, so
    // Tech reuses AI's per-topic runs rather than calling summarizeSource.
    const topics = [{ name: 'Tech>AI', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI': oneRun([1, 2], 'AI leaf') },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index['Tech'].runs).toEqual([{ sentences: [1, 2], text: 'AI leaf' }]);
    expect(index['Tech>AI'].runs).toEqual([{ sentences: [1, 2], text: 'AI leaf' }]);
  });

  it('delegates down a multi-level single-child chain to the deepest leaf anchor', async () => {
    // Tech>AI>LLM with LLM the only leaf: AI and Tech both cover exactly LLM's
    // sentences, so both delegate down to LLM's stored summary; no LLM call.
    const topics = [{ name: 'Tech>AI>LLM', sentences: [1, 2] }];
    const { nodes } = buildTopicTree(topics);
    const summarizeSource = vi.fn();

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI>LLM': oneRun([1, 2], 'llm leaf') },
      summarizeSource,
    });

    expect(summarizeSource).not.toHaveBeenCalled();
    expect(index['Tech'].runs[0].text).toBe('llm leaf');
    expect(index['Tech>AI'].runs[0].text).toBe('llm leaf');
    expect(index['Tech>AI>LLM'].runs[0].text).toBe('llm leaf');
  });

  it('reuses a child run but summarizes only the node-own sentences when they sit in a separate run', async () => {
    // The signature of per-run delegation. Tech>AI owns sentence [5] AND has a
    // child Tech>AI>LLM ([1,2]); [5] is non-adjacent to [1,2], so AI's source
    // ([1,2,5]) splits into two runs. Run [1,2] is wholly the LLM child → reused;
    // run [5] is AI's own content → summarized fresh. summarizeSource is therefore
    // called with ONLY [5], not AI's full source. Tech (one child, same source)
    // mirrors AI run-for-run.
    const topics = [
      { name: 'Tech>AI', sentences: [5] },
      { name: 'Tech>AI>LLM', sentences: [1, 2] },
    ];
    const { nodes } = buildTopicTree(topics);

    const calls = [];
    const summarizeSource = vi.fn(async (ids, info) => {
      calls.push({ ids, path: info.path });
      return oneRun(ids, 'AI own from source');
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI>LLM': oneRun([1, 2], 'llm leaf') },
      summarizeSource,
    });

    // summarizeSource runs once, for AI, over ONLY its own sentence [5].
    expect(calls).toEqual([{ ids: [5], path: 'Tech>AI' }]);
    expect(index['Tech>AI'].runs).toEqual([
      { sentences: [1, 2], text: 'llm leaf' },
      { sentences: [5], text: 'AI own from source' },
    ]);
    // Tech delegates run-for-run to AI (single child, identical source).
    expect(index['Tech'].runs).toEqual([
      { sentences: [1, 2], text: 'llm leaf' },
      { sentences: [5], text: 'AI own from source' },
    ]);
    expect(index['Tech>AI>LLM'].runs[0].text).toBe('llm leaf');
  });

  it('summarizes a whole run that mixes a child with node-own sentences', async () => {
    // Tech>AI owns [3] adjacent to its child Tech>AI>LLM ([1,2]); the three form a
    // single run [1,2,3] that mixes the child with AI's own sentence. A mixed run
    // is NOT reused — it is summarized fresh over the whole run so the node-own
    // content is not dropped.
    const topics = [
      { name: 'Tech>AI', sentences: [3] },
      { name: 'Tech>AI>LLM', sentences: [1, 2] },
    ];
    const { nodes } = buildTopicTree(topics);

    const calls = [];
    const summarizeSource = vi.fn(async (ids, info) => {
      calls.push({ ids, path: info.path });
      return oneRun(ids, 'AI from source');
    });

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: { 'Tech>AI>LLM': oneRun([1, 2], 'llm leaf') },
      summarizeSource,
    });

    expect(calls).toEqual([{ ids: [1, 2, 3], path: 'Tech>AI' }]);
    expect(index['Tech>AI'].runs).toEqual([{ sentences: [1, 2, 3], text: 'AI from source' }]);
    expect(index['Tech'].runs[0].text).toBe('AI from source');
    expect(index['Tech>AI>LLM'].runs[0].text).toBe('llm leaf');
  });

  it('on summarizeSource failure calls onError and falls back to empty runs', async () => {
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
      leafSummaries: { 'Tech>AI': oneRun([1], 'a'), 'Tech>HW': oneRun([2], 'b') },
      summarizeSource,
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith({ path: 'Tech', error: boom });
    // The single mixed run [1,2] was generated; on failure it degrades to empty
    // text (keeping its position) and retains a durable run-level marker.
    expect(index['Tech'].runs).toEqual([{ sentences: [1, 2], text: '', error: true }]);
    // Leaves are unaffected by the internal-node failure.
    expect(index['Tech>AI'].runs[0].text).toBe('a');
  });

  it('falls back to empty runs for a leaf with no stored summary', async () => {
    const topics = [{ name: 'A', sentences: [1] }];
    const { nodes } = buildTopicTree(topics);

    const index = await summarizeTopicTree({
      nodes,
      leafSummaries: {},
      summarizeSource: vi.fn(),
    });

    expect(index.A).toEqual({ runs: [], level: 0, source_sentences: [1] });
  });
});
