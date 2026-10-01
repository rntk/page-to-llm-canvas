import { describe, it, expect, vi } from 'vitest';
import {
  buildPartialTopicSummaryIndex,
  buildTopicTree,
  splitContiguousRuns,
  summarizeTopicTree,
} from './topicTreeMerge.js';

// Summaries contain one { sentences, text } entry per contiguous run.
const oneRun = (sentences, text) => ({ runs: [{ sentences, text }] });

describe('splitContiguousRuns', () => {
  it('sorts and deduplicates sentence ids before forming runs', () => {
    expect(splitContiguousRuns([6, 1, 5, 2, 2, 5])).toEqual([
      [1, 2],
      [5, 6],
    ]);
    expect(splitContiguousRuns([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(splitContiguousRuns([])).toEqual([]);
    expect(splitContiguousRuns(undefined)).toEqual([]);
  });
});

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
  it.each([
    ['unmarked', {}, true],
    ['failed', { error: true }, false],
    ['forced empty', { forcedEmpty: true }, false],
    ['accepted failure', { acceptedFailure: true }, false],
  ])(
    'handles an %s empty leaf when carrying parent work into retry',
    async (_, marker, reusable) => {
      const topics = [
        { name: 'Tech>A', sentences: [1] },
        { name: 'Tech>B', sentences: [2] },
      ];
      const leafSummaries = {
        'Tech>A': { runs: [{ sentences: [1], text: '', ...marker }], source_sentences: [1] },
        'Tech>B': { ...oneRun([2], 'B summary.'), source_sentences: [2] },
      };
      const partial = buildPartialTopicSummaryIndex(topics, leafSummaries, {
        Tech: oneRun([1, 2], 'Prior mixed-child summary.'),
      });

      if (reusable) {
        expect(partial.Tech.runs).toEqual(oneRun([1, 2], 'Prior mixed-child summary.').runs);
      } else {
        expect(partial.Tech).toBeUndefined();
      }
      const summarizeSource = vi.fn(async (sentences) => oneRun(sentences, 'Regenerated summary.'));
      const index = await summarizeTopicTree({
        nodes: buildTopicTree(topics).nodes,
        leafSummaries,
        previousSummaryIndex: partial,
        reusePriorSummaries: true,
        summarizeSource,
      });

      expect(summarizeSource).toHaveBeenCalledTimes(reusable ? 0 : 1);
      expect(index.Tech.runs).toEqual(
        oneRun([1, 2], reusable ? 'Prior mixed-child summary.' : 'Regenerated summary.').runs,
      );
    },
  );

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

  it('carries over prior internal-node runs that no failed leaf touches', () => {
    const index = buildPartialTopicSummaryIndex(
      [
        { name: 'Tech>AI', sentences: [1, 2] },
        { name: 'Tech>Hardware', sentences: [7] },
      ],
      {
        'Tech>AI': {
          runs: [{ sentences: [1, 2], text: 'AI summary.' }],
          source_sentences: [1, 2],
        },
        'Tech>Hardware': {
          runs: [{ sentences: [7], text: '', error: true }],
          source_sentences: [7],
          error: true,
        },
      },
      {
        Tech: {
          runs: [
            { sentences: [1, 2], text: 'Prior tech parent A.' },
            { sentences: [7], text: 'Prior tech parent B.' },
          ],
          level: 0,
          source_sentences: [1, 2, 7],
        },
      },
    );

    expect(index.Tech).toEqual({
      // The run over the failed leaf's source degrades to empty rather than
      // being shown as a successful ancestor summary.
      runs: [
        { sentences: [1, 2], text: 'Prior tech parent A.' },
        { sentences: [7], text: '' },
      ],
      level: 0,
      source_sentences: [1, 2, 7],
    });
  });

  it('omits a prior internal node whose runs are all invalidated or reshaped', () => {
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
          runs: [{ sentences: [3], text: '', error: true }],
          source_sentences: [3],
          error: true,
        },
      },
      {
        // Stale shape from a prior topic split, plus a failed run.
        Tech: {
          runs: [
            { sentences: [1], text: 'Stale partial.' },
            { sentences: [2, 3], text: '', error: true },
          ],
          level: 0,
          source_sentences: [1, 2, 3],
        },
        Gone: { runs: [{ sentences: [9], text: 'Removed topic.' }], level: 0 },
      },
    );

    expect(index.Tech).toBeUndefined();
    expect(index.Gone).toBeUndefined();
  });

  it('retains a failed prior internal node and blanks only the ancestor run above it', () => {
    const index = buildPartialTopicSummaryIndex(
      [
        { name: 'Tech>Sub>X', sentences: [1, 2] },
        { name: 'Tech>Sub>Y', sentences: [3] },
        { name: 'Tech>Solo', sentences: [8] },
        { name: 'News>Z', sentences: [12] },
      ],
      {
        'Tech>Sub>X': { runs: [{ sentences: [1, 2], text: 'X.' }], source_sentences: [1, 2] },
        'Tech>Sub>Y': { runs: [{ sentences: [3], text: 'Y.' }], source_sentences: [3] },
        'Tech>Solo': { runs: [{ sentences: [8], text: 'Solo.' }], source_sentences: [8] },
        // The leaf failure that parks this run is in an unrelated branch.
        'News>Z': {
          runs: [{ sentences: [12], text: '', error: true }],
          source_sentences: [12],
          error: true,
        },
      },
      {
        'Tech>Sub': {
          runs: [{ sentences: [1, 2, 3], text: '', error: true }],
          level: 1,
          source_sentences: [1, 2, 3],
        },
        Tech: {
          runs: [
            { sentences: [1, 2, 3], text: 'Parent over a failed subtree.' },
            { sentences: [8], text: 'Parent over solo.' },
          ],
          level: 0,
          source_sentences: [1, 2, 3, 8],
        },
      },
    );

    // The failed marker survives, so the next retry still sees the dependency.
    expect(index['Tech>Sub'].runs).toEqual([{ sentences: [1, 2, 3], text: '', error: true }]);
    expect(index.Tech.runs).toEqual([
      { sentences: [1, 2, 3], text: '' },
      { sentences: [8], text: 'Parent over solo.' },
    ]);
  });

  it('drops an ancestor entry whose every run sits above a failed prior descendant', () => {
    const index = buildPartialTopicSummaryIndex(
      [
        { name: 'Tech>Sub>X', sentences: [1, 2] },
        { name: 'Tech>Sub>Y', sentences: [3] },
        { name: 'News>Z', sentences: [12] },
      ],
      {
        'Tech>Sub>X': { runs: [{ sentences: [1, 2], text: 'X.' }], source_sentences: [1, 2] },
        'Tech>Sub>Y': { runs: [{ sentences: [3], text: 'Y.' }], source_sentences: [3] },
        'News>Z': {
          runs: [{ sentences: [12], text: '', error: true }],
          source_sentences: [12],
          error: true,
        },
      },
      {
        'Tech>Sub': {
          runs: [{ sentences: [1, 2, 3], text: '', error: true }],
          level: 1,
          source_sentences: [1, 2, 3],
        },
        Tech: {
          runs: [{ sentences: [1, 2, 3], text: 'Parent over a failed subtree.' }],
          level: 0,
          source_sentences: [1, 2, 3],
        },
      },
    );

    expect(index.Tech).toBeUndefined();
    expect(index['Tech>Sub'].runs).toEqual([{ sentences: [1, 2, 3], text: '', error: true }]);
  });

  it('prefers the current leaf checkpoint over a prior entry for the same path', () => {
    const index = buildPartialTopicSummaryIndex(
      [{ name: 'Tech>AI', sentences: [1] }],
      { 'Tech>AI': { runs: [{ sentences: [1], text: 'Fresh.' }], source_sentences: [1] } },
      { 'Tech>AI': { runs: [{ sentences: [1], text: 'Stale.' }], level: 1 } },
    );

    expect(index['Tech>AI'].runs).toEqual([{ sentences: [1], text: 'Fresh.' }]);
  });
});

describe('summarizeTopicTree', () => {
  it('uses the leaf summary for a leaf node without calling summarizeSource', async () => {
    // A top-level leaf reuses its precomputed runs.
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

    // Only Tech needs source summarization; leaves are precomputed.
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
    // Two separate runs each belong to one child, so both reuse child summaries.
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
    // Each domain has two children and must summarize from source.
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

    // Tech and Sci summarize from source; the root is skipped.
    expect(seenPaths.sort()).toEqual(['Sci', 'Tech']);
    expect(index['Tech'].runs[0].text).toBe('src Tech');
    expect(index['Sci'].runs[0].text).toBe('src Sci');
    expect(index['']).toBeUndefined();
  });

  it('delegates a single-child node to its child summary instead of regenerating', async () => {
    // Tech has only AI's source, so it reuses AI's runs.
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
    // AI and Tech both delegate to LLM's stored summary.
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
    // AI reuses LLM's [1,2] run and summarizes its own separate [5] run.
    // Tech delegates both runs to AI.
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
    // Adjacent child [1,2] and own [3] sentences form a mixed run to summarize.
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
    // Failed mixed runs keep their position and a durable failure marker.
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
