import { describe, it, expect, vi } from 'vitest';
import {
  PASSAGE,
  addNode,
  buildPassages,
  claimSentences,
  relay,
  treeLevels,
} from './summaryTreeModel.js';
import { decodeEntry, levelOf, requestItem } from './summaryTreeGeneration.js';
import { decodeAssignment, decodeTitles, orderGroups, OTHER_TITLE } from './summaryTreeTopics.js';
import { createSummaryTreeLlm, extractObject } from './summaryTreeRequests.js';
import { isSummaryTreeReusable, runSummaryTree } from './summaryTreeStage.js';
import { PROMPT_DELIMITER } from '../promptDelimiters.js';
import { readSummaryTree, SUMMARY_TREE_STATUS } from '../../shared/runtime/summaryTree.js';
import { buildSummaryTreeDisplayTree, flattenTree } from '../../topics-tree/topicsTreeModel.js';

const sentence = (n, chars = 100) => `S${n} ${'x'.repeat(chars)}.`;

describe('buildPassages', () => {
  it('cuts at primary topic boundaries and joins short pieces', () => {
    const texts = Array.from({ length: 6 }, (_, i) => sentence(i + 1, 300));
    const topics = [
      { name: 'A', sentences: [1, 2, 3] },
      { name: 'B', sentences: [4, 5, 6] },
    ];
    expect(buildPassages(texts, topics)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
    // A one-sentence run is too short on its own and joins its neighbour.
    expect(buildPassages(texts, [{ name: 'A', sentences: [1] }])).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  it('splits long runs evenly and skips blank sentences', () => {
    const texts = Array.from({ length: 10 }, (_, i) => sentence(i + 1, 500));
    texts[4] = '  ';
    const passages = buildPassages(texts, [], { targetChars: 1500, maxChars: 3000 });
    expect(passages.flat()).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    expect(passages.length).toBe(4);
  });
});

describe('summary tree model', () => {
  it('resolves claims down to sentence numbers and relays identical children', () => {
    const nodes = {};
    const a = addNode(nodes, PASSAGE, 'A', [], { sentences: [1, 2] });
    nodes[a].segments = [{ text: 'Claim.', sources: [{ kind: 'rows', first: 1, last: 2 }] }];
    const topic = addNode(nodes, 'topic', 'T', [a], { path: ['T'] });
    nodes[topic].segments = relay([nodes[a]]);
    expect(nodes[topic].segments).toEqual([
      { text: 'Claim.', sources: [{ kind: 'claim', child: a, segment: 0 }] },
    ]);
    expect(nodes[topic].sentences).toEqual([1, 2]);
    expect(claimSentences(nodes[topic], 0, nodes)).toEqual([1, 2]);
    expect(treeLevels(topic, nodes)).toBe(0);
  });
});

describe('decodeEntry', () => {
  const allowed = new Map([
    ['3', { kind: 'rows', first: 3, last: 3 }],
    ['4', { kind: 'rows', first: 4, last: 4 }],
    ['5', { kind: 'rows', first: 5, last: 5 }],
  ]);

  it('accepts cited segments, ranges, and connectors, joining with spaces', () => {
    const entry = {
      segments: [
        { text: 'First claim.', from: ['3'] },
        { text: 'and', from: [] },
        { text: 'second claim.', from: ['4-5'] },
      ],
    };
    expect(decodeEntry(entry, allowed)).toEqual([
      { text: 'First claim.', sources: [{ kind: 'rows', first: 3, last: 3 }] },
      { text: ' and', sources: [] },
      { text: ' second claim.', sources: [{ kind: 'rows', first: 4, last: 5 }] },
    ]);
  });

  it('rejects unknown labels, out-of-range spans, and uncited claims', () => {
    expect(decodeEntry({ segments: [{ text: 'X.', from: ['9'] }] }, allowed)).toBeNull();
    expect(decodeEntry({ segments: [{ text: 'X.', from: ['2-4'] }] }, allowed)).toBeNull();
    expect(decodeEntry({ segments: [{ text: 'Uncited claim.', from: [] }] }, allowed)).toBeNull();
    expect(decodeEntry({ segments: [] }, allowed)).toEqual([]);
  });
});

describe('topic answers', () => {
  const local = new Map([
    ['P1', 'n0'],
    ['P2', 'n1'],
    ['P3', 'n2'],
    ['P4', 'n3'],
  ]);

  it('validates assignments against ids, coverage, and new-topic budget', () => {
    const raw =
      '```json\n{"topics":[{"title":"Battery","passages":["P1","P3"]},{"title":"camera","passages":["P2"]}]}\n```';
    expect([...decodeAssignment(raw, local, ['Camera'], 1)]).toEqual([
      ['Battery', ['n0', 'n2']],
      ['Camera', ['n1']],
    ]);
    expect(decodeAssignment(raw, local, [], 1)).toBeNull();
    expect(
      decodeAssignment('{"topics":[{"title":"A","passages":["P1","P1"]}]}', local, [], 7),
    ).toBeNull();
    expect(
      decodeAssignment('{"topics":[{"title":"A","passages":["P1"]}]}', local, [], 7),
    ).toBeNull();
  });

  it('needs 2-7 distinct proposed titles', () => {
    expect(
      decodeTitles('{"topics":[{"title":"A","description":"About a"},{"title":"B"}]}'),
    ).toEqual({
      A: 'About a',
      B: 'B',
    });
    expect(decodeTitles('{"topics":[{"title":"A"},{"title":"Other"}]}')).toBeNull();
  });

  it('orders groups largest first with Other last, members in article order', () => {
    const topics = new Map([
      ['Small', ['n3']],
      ['Big', ['n2', 'n0']],
    ]);
    expect(orderGroups(topics, ['n1'], ['n0', 'n1', 'n2', 'n3'])).toEqual([
      ['Big', ['n0', 'n2']],
      ['Small', ['n3']],
      [OTHER_TITLE, ['n1']],
    ]);
    expect(orderGroups(new Map([['Only', ['n0']]]), [], ['n0'])).toBeNull();
  });
});

describe('createSummaryTreeLlm', () => {
  it('retries invalid answers and gives up after the bounded attempts', async () => {
    const callLLMWithRetry = vi.fn().mockResolvedValue('not json');
    const llm = createSummaryTreeLlm({ callLLMWithRetry });
    await expect(llm.ask('p', (raw) => extractObject(raw) !== null)).resolves.toBe(false);
    expect(callLLMWithRetry).toHaveBeenCalledTimes(3);
    expect(llm.metrics.invalidAnswers).toBe(3);
  });

  it('fails the run after repeated outages and on permanent errors', async () => {
    const outage = createSummaryTreeLlm({
      callLLMWithRetry: vi.fn().mockRejectedValue(new Error('network down')),
    });
    await expect(outage.ask('p', () => true)).resolves.toBe(false);
    await expect(outage.ask('p', () => true)).resolves.toBe(false);
    await expect(outage.ask('p', () => true)).rejects.toThrow(/3 requests in a row/);

    const denied = createSummaryTreeLlm({
      callLLMWithRetry: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('nope'), { status: 401 })),
    });
    await expect(denied.ask('p', () => true)).rejects.toThrow('nope');
  });
});

function payloadOf(prompt) {
  const start =
    prompt.indexOf(PROMPT_DELIMITER.payloadPrefix) + PROMPT_DELIMITER.payloadPrefix.length;
  return JSON.parse(prompt.slice(start, prompt.lastIndexOf(PROMPT_DELIMITER.close)).trim());
}

// Deterministic stand-in for the completion model, answering by task.
function fakeModel() {
  return vi.fn(async ({ prompt }) => {
    if (prompt.startsWith('TASK: GROUP PASSAGES')) {
      const { passages } = payloadOf(prompt);
      const half = Math.ceil(passages.length / 2);
      return JSON.stringify({
        topics: [
          { title: 'Alpha', passages: passages.slice(0, half).map((p) => p.id) },
          { title: 'Beta', passages: passages.slice(half).map((p) => p.id) },
        ],
      });
    }
    if (prompt.startsWith('TASK: PROPOSE SUB-TOPICS')) {
      return '{"topics":[{"title":"Alpha","description":"First"},{"title":"Beta","description":"Second"}]}';
    }
    const [node] = payloadOf(prompt).nodes;
    if (node.kind === 'passage') {
      const first = node.evidence.split('|')[0];
      return JSON.stringify({
        summaries: [
          {
            id: 'item',
            title: `About ${first}`,
            segments: [{ text: `Fact ${first}.`, from: [first] }],
          },
        ],
      });
    }
    const cites = node.children.flatMap((child) => child.claims.map((claim) => claim.cite));
    return JSON.stringify({
      summaries: [{ id: 'item', segments: [{ text: `${node.title} overview.`, from: cites }] }],
    });
  });
}

function makeRuntime(record) {
  const saves = [];
  return {
    saves,
    runtime: {
      maxTextChunkChars: 20000,
      log: vi.fn(async () => {}),
      saveSummaryTree: vi.fn(async (tree) => {
        saves.push(tree);
        record.summary_tree = tree;
      }),
    },
  };
}

describe('runSummaryTree', () => {
  const record = () => ({
    contentRevision: 'rev-1',
    sentences: Array.from({ length: 12 }, (_, i) => sentence(i + 1, 300)),
    topics: Array.from({ length: 6 }, (_, i) => ({
      name: `T>${i}`,
      sentences: [2 * i + 1, 2 * i + 2],
    })),
  });

  it('builds passages, topics, and cited bottom-up summaries', async () => {
    const rec = record();
    const { runtime } = makeRuntime(rec);
    const callLLMWithRetry = fakeModel();
    const tree = await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry,
      fingerprint: 'fp',
      heartbeatMs: 0,
    });
    expect(tree.status).toBe('done');
    expect(tree.metrics).toMatchObject({ passages: 6, topics: 2, levels: 1, llmInvalidAnswers: 0 });
    const root = tree.nodes[tree.rootId];
    expect(root.segments[0].text).toBe('Article overview.');
    expect(root.sentences).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Claims resolve to the sentences actually cited, not to membership.
    expect(claimSentences(root, 0, tree.nodes)).toEqual([1, 3, 5, 7, 9, 11]);

    const display = buildSummaryTreeDisplayTree(tree, { title: 'example.com' });
    expect(display.title).toBe('example.com');
    expect(display.children.map((child) => child.title)).toEqual(['Alpha', 'Beta']);
    const leaves = flattenTree(display).filter((node) => node.kind === 'leaf');
    expect(leaves[0]).toMatchObject({
      title: 'About 1',
      summary: 'Fact 1.',
      path: 'Alpha>About 1',
    });
    expect(readSummaryTree(rec, tree.updatedAt).status).toBe(SUMMARY_TREE_STATUS.DONE);
  });

  it('resumes a matching checkpoint without new requests and rebuilds when fresh', async () => {
    const rec = record();
    const { runtime } = makeRuntime(rec);
    await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry: fakeModel(),
      fingerprint: 'fp',
      heartbeatMs: 0,
    });
    expect(isSummaryTreeReusable(rec.summary_tree, rec, 'fp')).toBe(true);
    expect(isSummaryTreeReusable(rec.summary_tree, rec, 'other')).toBe(false);

    const again = fakeModel();
    await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry: again,
      fingerprint: 'fp',
      heartbeatMs: 0,
    });
    expect(again).not.toHaveBeenCalled();

    const fresh = fakeModel();
    await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry: fresh,
      fingerprint: 'fp',
      fresh: true,
      heartbeatMs: 0,
    });
    expect(fresh).toHaveBeenCalled();
  });

  it('assigns passages and verifies claims with decisions when available', async () => {
    const rec = record();
    const { runtime } = makeRuntime(rec);
    const decide = vi.fn(async (state, questions) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((name) => {
          if (name.startsWith('topic_')) {
            const index = Number(name.slice(6));
            return [name, { choice: index < 3 ? 'Alpha' : 'Beta' }];
          }
          // Claims about sentence 1 are unsupported; everything else fits.
          const unsupported = state.claims?.[name]?.claim === 'Fact 1.';
          return [
            name,
            {
              choice: unsupported ? 'no' : 'yes',
              probabilities: { yes: unsupported ? 0.1 : 0.9, no: unsupported ? 0.9 : 0.1 },
            },
          ];
        }),
      ),
    }));
    const tree = await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry: fakeModel(),
      decide,
      fingerprint: 'fp',
      heartbeatMs: 0,
    });
    expect(tree.status).toBe('done');
    expect(tree.metrics.decisionsActive).toBe(true);
    // The passage whose only claim kept failing verification was marked failed.
    expect(tree.metrics.failedPassages).toBe(1);
    const root = tree.nodes[tree.rootId];
    expect(root.children.map((id) => tree.nodes[id].title)).toEqual(['Alpha', 'Beta']);
    expect(tree.nodes[root.children[0]].children).toHaveLength(3);

    // The failed passage is outside the finished tree, so a resume asks nothing.
    const again = fakeModel();
    await runSummaryTree({
      runtime,
      record: rec,
      callLLMWithRetry: again,
      decide,
      fingerprint: 'fp',
      heartbeatMs: 0,
    });
    expect(again).not.toHaveBeenCalled();
  });

  it('marks unanswerable passages failed and fails without any summary', async () => {
    const rec = record();
    const { runtime } = makeRuntime(rec);
    await expect(
      runSummaryTree({
        runtime,
        record: rec,
        callLLMWithRetry: vi.fn().mockResolvedValue('{}'),
        fingerprint: 'fp',
        heartbeatMs: 0,
      }),
    ).rejects.toThrow('Could not summarize any passage');
    expect(Object.values(rec.summary_tree.nodes).every((node) => node.failed)).toBe(true);
  });
});

describe('summary tree levels', () => {
  it('picks the prompt intent from the node position', () => {
    const nodes = {};
    const p = addNode(nodes, PASSAGE, 'P', [], { sentences: [1] });
    const detail = addNode(nodes, 'topic', 'D', [p]);
    const overview = addNode(nodes, 'topic', 'O', [detail]);
    const root = addNode(nodes, 'root', 'R', [overview]);
    expect([p, detail, overview, root].map((id) => levelOf(nodes[id], nodes))).toEqual([
      'passage',
      'detail',
      'overview',
      'root',
    ]);
    nodes[p].segments = [{ text: 'A.', sources: [{ kind: 'rows', first: 1, last: 1 }] }];
    const { item, allowed } = requestItem(nodes[detail], nodes, ['One.']);
    expect(item.children).toEqual([{ title: 'P', claims: [{ cite: 'C1.S1', text: 'A.' }] }]);
    expect([...allowed.keys()]).toEqual(['C1.S1']);
  });
});
