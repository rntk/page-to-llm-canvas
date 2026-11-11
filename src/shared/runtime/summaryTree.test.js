import { describe, expect, it } from 'vitest';
import { canRecoverSummaryTree } from './summaryTree.js';

const record = (tree = {}) => ({
  contentRevision: 'current',
  summary_tree: {
    version: 1,
    status: 'running',
    contentRevision: 'current',
    updatedAt: 1,
    ...tree,
  },
});

describe('summary tree recovery eligibility', () => {
  it('requires explicit background recovery admission for legacy running trees', () => {
    expect(canRecoverSummaryTree(record().summary_tree, 'current')).toBe(false);
    expect(canRecoverSummaryTree(record({ updatedAt: Date.now() }).summary_tree, 'current')).toBe(
      false,
    );
  });
  it('recovers opted-in builds even after a long browser interruption', () => {
    expect(
      canRecoverSummaryTree(record({ backgroundRecovery: true }).summary_tree, 'current'),
    ).toBe(true);
  });
  it('rejects obsolete versions, content revisions and terminal states', () => {
    for (const tree of [
      { version: 0 },
      { contentRevision: 'old' },
      { status: 'cancelled' },
      { status: 'done' },
      { status: 'error' },
    ]) {
      expect(
        canRecoverSummaryTree(
          record({ backgroundRecovery: true, ...tree }).summary_tree,
          'current',
        ),
      ).toBe(false);
    }
    expect(canRecoverSummaryTree(null)).toBe(false);
  });
});
