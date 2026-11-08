import { describe, expect, it } from 'vitest';
import { describeMerge } from './projectMergeState.js';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';

const PAGES = [{ key: 'a', title: 'A' }];

describe('describeMerge', () => {
  it('treats a missing merge as an empty, unbuilt merge', () => {
    const state = describeMerge(undefined);
    expect(state).toMatchObject({
      status: SUMMARY_TREE_STATUS.MISSING,
      running: false,
      ready: false,
      resumable: false,
      updatable: false,
      needsBuild: false,
      eligible: [],
      skipped: [],
      changeText: '',
      stateText: 'Merge primary topics from completed saved pages in this project.',
    });
    expect(describeMerge(null, { pending: true }).stateText).toBe('Starting the merge…');
  });

  it('needs a build only when pages are known to be eligible', () => {
    expect(describeMerge({ status: 'missing', tree: null }).needsBuild).toBe(false);
    expect(describeMerge({ status: 'missing', tree: null, eligiblePages: [] }).needsBuild).toBe(
      false,
    );
    expect(
      describeMerge({ status: 'missing', tree: null, eligiblePages: PAGES }).needsBuild,
    ).toBe(true);
  });

  it('does not start a build while one is running', () => {
    const state = describeMerge({
      status: 'running',
      tree: null,
      eligiblePages: PAGES,
    });
    expect(state.running).toBe(true);
    expect(state.needsBuild).toBe(false);
    expect(state.stateText).toBe('Starting…');
  });

  it('reports running progress', () => {
    const tree = { stage: 'topics', progress: { done: 2, total: 5 } };
    expect(describeMerge({ status: 'running', tree }).stateText).toBe(
      'Merging similar topics 2/5…',
    );
  });

  it.each([
    ['cancelled', 'The merge was stopped.'],
    ['interrupted', 'The merge was interrupted.'],
    ['error', 'The merge failed.'],
  ])('resumes a %s merge', (status, text) => {
    const state = describeMerge({ status, tree: { records: [] }, eligiblePages: PAGES });
    expect(state).toMatchObject({ resumable: true, needsBuild: true, stateText: text });
  });

  it('marks a finished merge ready, and updatable when stale', () => {
    const tree = { records: [{}, {}] };
    const fresh = describeMerge({ status: 'done', tree, eligiblePages: PAGES });
    expect(fresh).toMatchObject({
      ready: true,
      updatable: false,
      needsBuild: false,
      stateText: 'Merged topics from 2 articles',
    });

    const stale = describeMerge({
      status: 'done',
      tree,
      stale: true,
      eligiblePages: PAGES,
      changes: { added: 1, changed: 0, removed: 2 },
    });
    expect(stale).toMatchObject({
      updatable: true,
      needsBuild: true,
      changeText: '1 new, 2 removed',
    });
  });

  it('is not ready without a tree', () => {
    expect(describeMerge({ status: 'done', tree: null }).ready).toBe(false);
  });
});
