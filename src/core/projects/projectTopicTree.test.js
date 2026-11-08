import { describe, expect, it, vi } from 'vitest';
import {
  buildProjectTopicSeed,
  diffProjectRecords,
  hasProjectTopicSource,
  prepareIncrementalProjectTree,
  projectTopicSourceRevision,
} from './projectTopicTree.js';
import { runSummaryTree } from '../pipeline/summaryTreeStage.js';
import { createProjectStrategy } from './projectTopicStrategy.js';
import { claimSentences } from '../pipeline/summaryTreeModel.js';
import {
  buildTopicGroupingPrompt,
  buildTopicTitlesPrompt,
} from '../pipeline/summaryTreePrompts.js';
import { decodeTitles } from '../pipeline/summaryTreeTopics.js';

const record = (key, overrides = {}) => ({
  key,
  status: 'done',
  sourceUrl: `https://${key}.test/`,
  title: `Article ${key}`,
  contentRevision: `rev-${key}`,
  sentences: [`${key} source one.`, `${key} source two.`],
  topics: [{ name: 'Shared topic', sentences: [1, 2] }],
  topic_summary_index: {
    'Shared topic': { runs: [{ text: `${key} summary.`, sentences: [1, 2] }] },
  },
  ...overrides,
});

describe('project primary topic sources', () => {
  it('asks to merge existing article topics and permits one shared subject only for project proposals', () => {
    const payload = { source_kind: 'project_primary_topics' };
    expect(buildTopicGroupingPrompt(payload)).toContain(
      'existing primary topics from several source articles',
    );
    expect(buildTopicGroupingPrompt(payload)).toContain('into 1-7');
    expect(buildTopicTitlesPrompt(payload)).toContain('Propose 1-7');
    const proposal = JSON.stringify({
      topics: [{ title: 'Shared subject', description: 'One shared subject.' }],
    });
    expect(decodeTitles(proposal)).toBeNull();
    expect(decodeTitles(proposal, true)).toEqual({ 'Shared subject': 'One shared subject.' });
  });

  it('keeps identical local sentence ids distinct and reuses only locally cited summaries', () => {
    const seed = buildProjectTopicSeed([record('a'), record('b')]);
    expect(seed.sourceTopicIds).toHaveLength(2);
    expect(seed.nodes.n0.segments[0].sources).toEqual([
      { kind: 'rows', first: 1, last: 1 },
      { kind: 'rows', first: 2, last: 2 },
    ]);
    expect(seed.nodes.n1.segments[0].sources).toEqual([
      { kind: 'rows', first: 3, last: 3 },
      { kind: 'rows', first: 4, last: 4 },
    ]);
    expect(seed.sources[1]).toMatchObject({ recordKey: 'a', sentenceId: 1 });
    expect(seed.sources[3]).toMatchObject({ recordKey: 'b', sentenceId: 1 });
    const invalid = record('a');
    invalid.topic_summary_index['Shared topic'].runs[0].sentences = [9];
    expect(buildProjectTopicSeed([invalid]).nodes.n0.segments).toBeNull();
  });

  it('chunks large topics inside their original boundaries and groups each topic as one unit', () => {
    const input = record('a', {
      sentences: ['A'.repeat(100), 'B'.repeat(100), 'C'.repeat(100), 'D'.repeat(100)],
      topics: [
        { name: 'First', sentences: [1, 3] },
        { name: 'Second', sentences: [2, 4] },
      ],
      topic_summary_index: null,
    });
    const seed = buildProjectTopicSeed([input], { maxChars: 150 });
    expect(seed.sourceTopicIds).toHaveLength(2);
    const [first, second] = seed.sourceTopicIds.map((id) => seed.nodes[id]);
    expect(first).toMatchObject({ kind: 'topic', title: 'First', sentences: [1, 3] });
    expect(second).toMatchObject({ kind: 'topic', title: 'Second', sentences: [2, 4] });
    expect(first.children.map((id) => seed.nodes[id].sentences)).toEqual([[1], [3]]);
  });

  it('requires complete saved splits and invalidates a checkpoint after a topic change', () => {
    const source = record('a');
    expect(hasProjectTopicSource(source)).toBe(true);
    expect(hasProjectTopicSource({ ...source, status: 'splitting' })).toBe(false);
    expect(hasProjectTopicSource({ ...source, topics: [{ name: 'Bad', sentences: [8] }] })).toBe(
      false,
    );
    const revision = projectTopicSourceRevision([source]);
    expect(projectTopicSourceRevision([structuredClone(source)])).toBe(revision);
    source.topics[0].name = 'Changed split';
    expect(projectTopicSourceRevision([source])).not.toBe(revision);
  });

  it('merges small sets of existing topics and resolves every citation to its own article', async () => {
    const seed = buildProjectTopicSeed([record('a'), record('b')]);
    const saved = [];
    const completion = vi.fn(async ({ prompt }) =>
      prompt.includes('"passages"')
        ? JSON.stringify({ topics: [{ title: 'Common subject', passages: ['P1', 'P2'] }] })
        : JSON.stringify({
            summaries: [
              {
                id: 'item',
                segments: [
                  { text: 'Both articles discuss the common subject.', from: ['C1.S1', 'C2.S1'] },
                ],
              },
            ],
          }),
    );
    const tree = await runSummaryTree({
      runtime: {
        log: async () => {},
        saveSummaryTree: async (tree) => saved.push(structuredClone(tree)),
      },
      strategy: createProjectStrategy({
        seed,
        prior: null,
        contentRevision: 'project-rev',
      }),
      fingerprint: 'provider',
      callLLMWithRetry: completion,
      heartbeatMs: 0,
    });
    expect(tree.status).toBe('done');
    expect(tree.nodes[tree.rootId].children).toHaveLength(1);
    expect(claimSentences(tree.nodes[tree.rootId], 0, tree.nodes)).toEqual([1, 2, 3, 4]);
    expect(completion).toHaveBeenCalledTimes(2); // grouping + merged overview; root relays it
    const resumed = await runSummaryTree({
      runtime: { log: async () => {}, saveSummaryTree: async () => {} },
      strategy: createProjectStrategy({
        seed,
        prior: tree,
        contentRevision: 'project-rev',
      }),
      fingerprint: 'provider',
      callLLMWithRetry: completion,
      heartbeatMs: 0,
    });
    expect(resumed.status).toBe('done');
    expect(completion).toHaveBeenCalledTimes(2);
    expect(saved.at(-1).status).toBe('done');
  });

  describe('incremental merge', () => {
    const answer = ({ prompt }) =>
      prompt.includes('"passages"')
        ? JSON.stringify({
            topics: [
              {
                title: 'Common subject',
                passages: [...new Set(prompt.match(/"id":"P\d+"/g))].map((label) =>
                  label.slice(6, -1),
                ),
              },
            ],
          })
        : JSON.stringify({
            summaries: [{ id: 'item', segments: [{ text: 'Overview.', from: ['C1.S1'] }] }],
          });

    async function mergeAll(records, { prior, incremental, completion }) {
      const saved = [];
      const seed = incremental ? incremental.seed : buildProjectTopicSeed(records);
      const tree = await runSummaryTree({
        runtime: {
          log: async () => {},
          saveSummaryTree: async (next) =>
            saved.push(
              structuredClone({
                ...next,
                sentences: seed.sentences,
                sources: seed.sources,
                records: seed.records,
              }),
            ),
        },
        strategy: createProjectStrategy({
          seed,
          prior: incremental ? incremental.tree : prior,
          contentRevision: projectTopicSourceRevision(records),
          extending: Boolean(incremental),
        }),
        fingerprint: 'provider',
        callLLMWithRetry: completion,
        heartbeatMs: 0,
      });
      return { tree: saved.at(-1), result: tree, saved };
    }

    it('reports content changes regardless of order or title', () => {
      const a = record('a');
      const b = record('b');
      const { records } = buildProjectTopicSeed([a, b]);
      expect(diffProjectRecords(records, [{ ...b, title: 'Renamed' }, a]).total).toBe(0);
      const edited = record('a', { sentences: ['Edited one.', 'Edited two.'] });
      const diff = diffProjectRecords(records, [edited, record('c')]);
      expect(diff.changed.map((item) => item.key)).toEqual(['a']);
      expect(diff.added.map((item) => item.key)).toEqual(['c']);
      expect(diff.removed.map((item) => item.key)).toEqual(['b']);
    });

    it('attaches a new page to the existing branch and rewrites only that path', async () => {
      const completion = vi.fn(async (input) => answer(input));
      const first = await mergeAll([record('a'), record('b')], { completion });
      expect(first.tree.status).toBe('done');
      const callsAfterFirst = completion.mock.calls.length;
      const before = structuredClone(first.tree.nodes);

      const records = [record('a'), record('b'), record('c')];
      const incremental = prepareIncrementalProjectTree(first.tree, records, {
        contentRevision: projectTopicSourceRevision(records),
      });
      expect(incremental.changes.added.map((item) => item.key)).toEqual(['c']);
      // Existing rows keep their ids; the new page appends after them.
      expect(incremental.seed.sources[5]).toMatchObject({ recordKey: 'c', sentenceId: 1 });
      expect(incremental.seed.records.map((item) => item.key)).toEqual(['a', 'b', 'c']);

      const second = await mergeAll(records, { incremental, completion });
      expect(second.tree.status).toBe('done');
      // One placement request and one rewritten branch; the root relays it.
      expect(completion.mock.calls.length - callsAfterFirst).toBe(2);
      const root = second.tree.nodes[second.tree.rootId];
      expect(root.children).toHaveLength(1);
      const branch = second.tree.nodes[root.children[0]];
      expect(branch.children).toHaveLength(3);
      expect(branch.sentences).toEqual([1, 2, 3, 4, 5, 6]);
      for (const [id, node] of Object.entries(before)) {
        if (node.kind === 'passage') expect(second.tree.nodes[id]).toEqual(node);
      }
      expect(Object.values(second.tree.nodes).some((node) => node.unplaced)).toBe(false);
    });

    it('drops a removed page and resumes an interrupted addition without redoing it', async () => {
      const completion = vi.fn(async (input) => answer(input));
      const first = await mergeAll([record('a'), record('b')], { completion });
      const records = [record('b')];
      const incremental = prepareIncrementalProjectTree(first.tree, records, {
        contentRevision: projectTopicSourceRevision(records),
      });
      expect(incremental.changes.removed.map((item) => item.key)).toEqual(['a']);
      expect(Object.values(incremental.tree.nodes).some((node) => node.recordKey === 'a')).toBe(
        false,
      );
      const root = incremental.tree.nodes[incremental.tree.rootId];
      expect(incremental.tree.nodes[root.children[0]].segments).toBeNull();
      expect(root.segments).toBeNull();

      const withAdd = [record('b'), record('c')];
      const extended = prepareIncrementalProjectTree(first.tree, withAdd, {
        contentRevision: projectTopicSourceRevision(withAdd),
      });
      // An interrupted run saved the unplaced unit; resuming needs no new diff.
      const unit = Object.values(extended.tree.nodes).find((node) => node.unplaced);
      expect(unit.recordKey).toBe('c');
      const resumed = prepareIncrementalProjectTree(
        {
          ...extended.tree,
          sentences: extended.seed.sentences,
          sources: extended.seed.sources,
          records: extended.seed.records,
        },
        withAdd,
        { contentRevision: projectTopicSourceRevision(withAdd) },
      );
      expect(resumed.changes.total).toBe(0);
      const done = await mergeAll(withAdd, { incremental: resumed, completion });
      expect(done.tree.status).toBe('done');
      expect(Object.values(done.tree.nodes).some((node) => node.unplaced)).toBe(false);
    });

    it('cannot extend a tree that never got a root', () => {
      expect(prepareIncrementalProjectTree({ nodes: {} }, [record('a')], {})).toBeNull();
    });
  });
});
