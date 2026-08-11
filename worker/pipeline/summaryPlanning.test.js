import { describe, it, expect } from 'vitest';
import { planSummaryWork } from './summaryPlanning.js';

const topics = [
  { name: 'A', sentences: [1] },
  { name: 'B', sentences: [2] },
  { name: 'C', sentences: [3] },
];

describe('planSummaryWork', () => {
  it('treats every topic as pending on a fresh run (no previous summaries)', () => {
    const plan = planSummaryWork(topics, {});
    expect(plan.pending.map((entry) => entry.name)).toEqual(['A', 'B', 'C']);
    expect(plan.pendingCount).toBe(3);
    expect(plan.reusedCount).toBe(0);
    expect(plan.total).toBe(3);
    expect(plan.reused).toEqual({});
  });

  it('defaults previousSummaries to empty when omitted', () => {
    const plan = planSummaryWork(topics);
    expect(plan.pendingCount).toBe(3);
    expect(plan.reused).toEqual({});
  });

  it('reuses structurally valid completed summaries and leaves the rest pending', () => {
    const plan = planSummaryWork(topics, {
      A: { runs: [{ sentences: [1], text: 'Done A' }], source_sentences: [99] },
    });
    expect(plan.reused).toEqual({
      A: { runs: [{ sentences: [1], text: 'Done A' }], source_sentences: [1] },
    });
    expect(plan.pending.map((t) => t.name)).toEqual(['B', 'C']);
    expect(plan.reusedCount).toBe(1);
    expect(plan.pendingCount).toBe(2);
  });

  it('reuses a stored NO_SUMMARY fallback but retries error-flagged entries', () => {
    const plan = planSummaryWork(topics, {
      A: { runs: [{ sentences: [1], text: 'Good A' }] },
      // The summary stage stores NO_SUMMARY as the original source text, not
      // an empty run list (which would otherwise be indistinguishable from a
      // damaged checkpoint).
      B: { runs: [{ sentences: [2], text: 'Beta.' }] },
      C: { runs: [{ sentences: [3], text: '' }], error: true }, // failed — retry
    });
    expect(Object.keys(plan.reused).sort()).toEqual(['A', 'B']);
    expect(plan.reused.B).toEqual({
      runs: [{ sentences: [2], text: 'Beta.' }],
      source_sentences: [2],
    });
    expect(plan.pending.map((t) => t.name)).toEqual(['C']);
    expect(plan.reusedCount).toBe(2);
    expect(plan.pendingCount).toBe(1);
  });

  it('retries a force-accepted failure marked forcedEmpty', () => {
    const plan = planSummaryWork(topics, {
      A: { runs: [{ sentences: [1], text: 'Good A' }] },
      B: { runs: [{ sentences: [2], text: 'Beta.' }] }, // valid — reuse
      C: { runs: [{ sentences: [3], text: '' }], forcedEmpty: true }, // retry
    });
    expect(Object.keys(plan.reused).sort()).toEqual(['A', 'B']);
    expect(plan.pending.map((t) => t.name)).toEqual(['C']);
    expect(plan.pendingCount).toBe(1);
  });

  it('reuses an acceptedFailure leaf without re-querying it but carries the marker over', () => {
    // "Skip" means the leaf is accepted as-is, so it must NOT go pending; the
    // marker still has to survive the narrowed reused shape or the downstream
    // force-finalize pass cannot see the failure at all.
    const plan = planSummaryWork(topics, {
      A: { runs: [{ sentences: [1], text: 'Good A' }] },
      C: {
        runs: [{ sentences: [3], text: '' }],
        source_sentences: [3],
        acceptedFailure: true,
        error_kind: 'timeout',
      },
    });
    expect(plan.pending.map((t) => t.name)).toEqual(['B']);
    expect(plan.reused.C).toEqual({
      runs: [{ sentences: [3], text: '', acceptedFailure: true }],
      source_sentences: [3],
      acceptedFailure: true,
    });
  });

  it('regenerates malformed checkpoint entries instead of silently reusing them', () => {
    const topic = [{ name: 'A', sentences: [1, 2] }];
    for (const previous of [
      {},
      { runs: [] },
      { runs: [{ sentences: [1], text: 'only part of the topic' }] },
      { runs: [{ sentences: [1, 2], text: 42 }] },
      { runs: [{ sentences: [2, 1], text: 'wrong order' }] },
    ]) {
      const plan = planSummaryWork(topic, { A: previous });
      expect(plan.reused).toEqual({});
      expect(plan.pending.map((entry) => entry.name)).toEqual(['A']);
    }
  });

  it('reuses an empty run list only for an empty-source topic', () => {
    const topic = [{ name: 'A', sentences: [] }];
    const plan = planSummaryWork(topic, { A: { runs: [] } });
    expect(plan.reused.A).toEqual({ runs: [], source_sentences: [] });
  });

  it('reuses runs for unsorted, duplicate topic sentence ids', () => {
    const topic = [{ name: 'A', sentences: [6, 1, 5, 2, 2, 6] }];
    const plan = planSummaryWork(topic, {
      A: {
        runs: [
          { sentences: [1, 2], text: 'First occurrence.' },
          { sentences: [5, 6], text: 'Second occurrence.' },
        ],
      },
    });

    expect(plan.pending).toEqual([]);
    expect(plan.reused.A).toEqual({
      runs: [
        { sentences: [1, 2], text: 'First occurrence.' },
        { sentences: [5, 6], text: 'Second occurrence.' },
      ],
      source_sentences: [6, 1, 5, 2, 2, 6],
    });
  });

  it('retains successful runs from a topic-level error checkpoint', () => {
    const topic = [{ name: 'A', sentences: [1, 2, 5, 6] }];
    const plan = planSummaryWork(topic, {
      A: {
        runs: [
          { sentences: [1, 2], text: 'Recovered already.' },
          { sentences: [5, 6], text: '', error: true, error_kind: 'timeout' },
        ],
        source_sentences: [1, 2, 5, 6],
        error: true,
      },
    });

    expect(plan.pending.map((entry) => entry.name)).toEqual(['A']);
    expect(plan.pending[0].runResults).toEqual([
      { sentences: [1, 2], text: 'Recovered already.' },
      { sentences: [5, 6], text: '', error: true, error_kind: 'timeout' },
    ]);
    expect(plan.pending[0].pendingRunIndexes).toEqual([1]);
    expect(plan.pendingCount).toBe(1);
  });

  it('reuses only accepted runs when a modern checkpoint has per-run failures', () => {
    const topic = [{ name: 'A', sentences: [1, 5] }];
    const plan = planSummaryWork(topic, {
      A: {
        runs: [
          { sentences: [1], text: '', acceptedFailure: true },
          { sentences: [5], text: '', error: true },
        ],
        source_sentences: [1, 5],
        acceptedFailure: true,
        error: true,
      },
    });

    expect(plan.pending[0].runResults).toEqual([
      { sentences: [1], text: '', acceptedFailure: true },
      { sentences: [5], text: '', error: true },
    ]);
    expect(plan.pending[0].pendingRunIndexes).toEqual([1]);
    expect(plan.pending[0].acceptedFailure).toBe(true);
  });

  it('does not infer modern unmarked empty siblings as failed or accepted', () => {
    const topic = [{ name: 'A', sentences: [1, 5, 9] }];
    const plan = planSummaryWork(topic, {
      A: {
        runs: [
          { sentences: [1], text: '', acceptedFailure: true },
          { sentences: [5], text: '' },
          { sentences: [9], text: '', error: true },
        ],
        source_sentences: [1, 5, 9],
        acceptedFailure: true,
        error: true,
      },
    });

    expect(plan.pending[0].runResults).toEqual([
      { sentences: [1], text: '', acceptedFailure: true },
      { sentences: [5], text: '' },
      { sentences: [9], text: '', error: true },
    ]);
    expect(plan.pending[0].pendingRunIndexes).toEqual([2]);
  });

  it('handles empty topics', () => {
    const plan = planSummaryWork([], { A: { runs: [{ sentences: [1], text: 'x' }] } });
    expect(plan.pending).toEqual([]);
    expect(plan.reused).toEqual({});
    expect(plan.total).toBe(0);
    expect(plan.reusedCount).toBe(0);
    expect(plan.pendingCount).toBe(0);
  });
});
