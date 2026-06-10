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
    expect(plan.pending).toEqual(topics);
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

  it('reuses completed summaries and leaves the rest pending', () => {
    const plan = planSummaryWork(topics, {
      A: { text: 'Done A', source_sentences: [99] },
    });
    expect(plan.reused).toEqual({
      A: { text: 'Done A', source_sentences: [1] },
    });
    expect(plan.pending.map((t) => t.name)).toEqual(['B', 'C']);
    expect(plan.reusedCount).toBe(1);
    expect(plan.pendingCount).toBe(2);
  });

  it('reuses a legit empty (NO_SUMMARY) result but retries error-flagged ones', () => {
    const plan = planSummaryWork(topics, {
      A: { text: 'Good A' },
      B: { text: '' }, // legit NO_SUMMARY — reuse
      C: { text: '', error: true }, // failed — retry
    });
    expect(Object.keys(plan.reused).sort()).toEqual(['A', 'B']);
    expect(plan.reused.B).toEqual({ text: '', source_sentences: [2] });
    expect(plan.pending.map((t) => t.name)).toEqual(['C']);
    expect(plan.reusedCount).toBe(2);
    expect(plan.pendingCount).toBe(1);
  });

  it('normalizes a missing text field to empty string when reusing', () => {
    const plan = planSummaryWork([{ name: 'A', sentences: [1] }], { A: {} });
    expect(plan.reused.A).toEqual({ text: '', source_sentences: [1] });
  });

  it('handles empty topics', () => {
    const plan = planSummaryWork([], { A: { text: 'x' } });
    expect(plan.pending).toEqual([]);
    expect(plan.reused).toEqual({});
    expect(plan.total).toBe(0);
    expect(plan.reusedCount).toBe(0);
    expect(plan.pendingCount).toBe(0);
  });
});
