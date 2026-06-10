import { describe, it, expect, vi } from 'vitest';
import { summarizeTopicTree } from './topicTreeMerge.js';
import { buildTopicTree } from './orchestrator.js';

// A passthrough limiter that just runs the task (the real createLimiter caps
// concurrency; here we instrument it where a test needs to assert the cap).
const passthroughLimit = (fn) => fn();

describe('summarizeTopicTree', () => {
  it('produces an index from a single-leaf tree without calling merge', async () => {
    // One top-level topic: root has a single child and inherits its summary, so
    // no merge LLM call is made.
    const topics = [{ name: 'A', sentences: [1, 2] }];
    const { root, nodes } = buildTopicTree(topics);
    const merge = vi.fn();

    const index = await summarizeTopicTree({
      root,
      nodes,
      leafSummaries: { A: { text: 'Summary A' } },
      merge,
      limit: passthroughLimit,
    });

    expect(merge).not.toHaveBeenCalled();
    expect(index.A).toEqual({ text: 'Summary A', level: 0, source_sentences: [1, 2] });
    // The empty root path is excluded.
    expect(Object.keys(index)).toEqual(['A']);
  });

  it('merges children before parents (bottom-up) and records the parent summary', async () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1, 2] },
      { name: 'Tech>HW', sentences: [3, 4] },
    ];
    const { root, nodes } = buildTopicTree(topics);

    const mergeOrder = [];
    const merge = vi.fn(async (records) => {
      mergeOrder.push(records.map((r) => r.summary.text));
      return { text: 'Merged Tech' };
    });

    const index = await summarizeTopicTree({
      root,
      nodes,
      leafSummaries: {
        'Tech>AI': { text: 'AI leaf' },
        'Tech>HW': { text: 'HW leaf' },
      },
      merge,
      limit: passthroughLimit,
    });

    // Exactly one merge: the two leaves into Tech. (Tech is Tech's single child
    // of root, so root inherits Tech's summary without a second merge.)
    expect(merge).toHaveBeenCalledTimes(1);
    expect(mergeOrder).toEqual([['AI leaf', 'HW leaf']]);
    expect(index['Tech'].text).toBe('Merged Tech');
    expect(index['Tech'].level).toBe(0);
    expect(index['Tech>AI'].text).toBe('AI leaf');
    expect(index['Tech>AI'].level).toBe(1);
    expect(index['Tech'].source_sentences).toEqual([1, 2, 3, 4]);
  });

  it('passes child sentence bounds into the merge records', async () => {
    const topics = [
      { name: 'T>X', sentences: [2, 5] },
      { name: 'T>Y', sentences: [7, 9] },
    ];
    const { root, nodes } = buildTopicTree(topics);
    let captured;
    const merge = vi.fn(async (records) => {
      captured = records;
      return { text: 'M' };
    });

    await summarizeTopicTree({
      root,
      nodes,
      leafSummaries: { 'T>X': { text: 'x' }, 'T>Y': { text: 'y' } },
      merge,
      limit: passthroughLimit,
    });

    expect(captured).toEqual([
      { start_sentence: 2, end_sentence: 5, summary: { text: 'x' } },
      { start_sentence: 7, end_sentence: 9, summary: { text: 'y' } },
    ]);
  });

  it('on merge failure calls onMergeError and falls back to empty text', async () => {
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'Tech>HW', sentences: [2] },
    ];
    const { root, nodes } = buildTopicTree(topics);
    const onMergeError = vi.fn();
    const merge = vi.fn(async () => {
      throw new Error('merge boom');
    });

    const index = await summarizeTopicTree({
      root,
      nodes,
      leafSummaries: { 'Tech>AI': { text: 'a' }, 'Tech>HW': { text: 'b' } },
      merge,
      limit: passthroughLimit,
      onMergeError,
    });

    expect(onMergeError).toHaveBeenCalledTimes(1);
    expect(onMergeError).toHaveBeenCalledWith({ path: 'Tech', error: 'merge boom' });
    expect(index['Tech'].text).toBe('');
  });

  it('routes every merge through the limiter and respects the concurrency cap', async () => {
    // Two parents (Tech, Sci) each with two leaves, plus the root which now has
    // two children (Tech, Sci) => three merges total. The Tech/Sci merges would
    // otherwise launch concurrently; a cap-1 limiter must serialize all of them.
    const topics = [
      { name: 'Tech>AI', sentences: [1] },
      { name: 'Tech>HW', sentences: [2] },
      { name: 'Sci>Bio', sentences: [3] },
      { name: 'Sci>Chem', sentences: [4] },
    ];
    const { root, nodes } = buildTopicTree(topics);

    let inFlight = 0;
    let maxInFlight = 0;
    const CAP = 1;
    const limit = (fn) => {
      // Minimal cap-1 limiter for the assertion below.
      return queue(fn);
    };
    let chain = Promise.resolve();
    function queue(fn) {
      const run = chain.then(() => fn());
      // keep the chain going only after run settles
      chain = run.then(
        () => {},
        () => {},
      );
      return run;
    }

    const merge = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { text: 'merged' };
    });

    const index = await summarizeTopicTree({
      root,
      nodes,
      leafSummaries: {
        'Tech>AI': { text: '' },
        'Tech>HW': { text: '' },
        'Sci>Bio': { text: '' },
        'Sci>Chem': { text: '' },
      },
      merge,
      limit,
    });

    expect(merge).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBeLessThanOrEqual(CAP);
    expect(index['Tech'].text).toBe('merged');
    expect(index['Sci'].text).toBe('merged');
  });
});
