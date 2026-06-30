import { describe, it, expect, vi } from 'vitest';
import { getSentencesForNode, getTopicSentenceNumbersRaw } from './hierarchyUtils.js';
import { getTopicSentenceNumbers } from '../topicCards.js';

vi.mock('../topicCards.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getTopicSentenceNumbers: vi.fn(actual.getTopicSentenceNumbers),
  };
});

/** Build a minimal tree entry with explicit sentence numbers. */
function makeLeaf(fullPath, sentences = []) {
  return {
    node: {
      name: fullPath.split('>').pop(),
      fullPath,
      depth: fullPath.split('>').length - 1,
      topic: { sentences },
    },
    children: new Map(),
    parent: null,
  };
}

/** Build a branch entry with given children entries. */
function makeBranch(fullPath, childEntries = []) {
  const children = new Map();
  for (const child of childEntries) {
    children.set(child.node.name, child);
  }
  return {
    node: {
      name: fullPath.split('>').pop(),
      fullPath,
      depth: fullPath.split('>').length - 1,
      topic: null,
    },
    children,
    parent: null,
  };
}

describe('getSentencesForNode', () => {
  it('returns empty array for a leaf node with no sentences', () => {
    const entry = makeLeaf('Tech>Empty', []);
    expect(getSentencesForNode(entry)).toEqual([]);
  });

  it('returns sorted sentence numbers for a leaf node', () => {
    const entry = makeLeaf('Tech>All', [3, 1, 2]);
    expect(getSentencesForNode(entry)).toEqual([1, 2, 3]);
  });

  it('collects sentences from all leaf descendants of a branch', () => {
    const leaf1 = makeLeaf('Tech>A', [1, 2]);
    const leaf2 = makeLeaf('Tech>B', [3, 4]);
    const branch = makeBranch('Tech', [leaf1, leaf2]);
    expect(getSentencesForNode(branch)).toEqual([1, 2, 3, 4]);
  });

  it('deduplicates sentence numbers shared across descendants', () => {
    const leaf1 = makeLeaf('Tech>A', [1, 2, 3]);
    const leaf2 = makeLeaf('Tech>B', [2, 3, 4]);
    const branch = makeBranch('Tech', [leaf1, leaf2]);
    expect(getSentencesForNode(branch)).toEqual([1, 2, 3, 4]);
  });

  it('includes own-topic sentences as well as children sentences', () => {
    const child = makeLeaf('Tech>A>Sub', [5, 6]);
    const branch = {
      node: { name: 'A', fullPath: 'Tech>A', depth: 1, topic: { sentences: [1, 2] } },
      children: new Map([['Sub', child]]),
      parent: null,
    };
    expect(getSentencesForNode(branch)).toEqual([1, 2, 5, 6]);
  });

  it('handles deeply nested hierarchy', () => {
    const deepLeaf = makeLeaf('A>B>C>D', [10]);
    const level3 = makeBranch('A>B>C', [deepLeaf]);
    const level2 = makeBranch('A>B', [level3]);
    const root = makeBranch('A', [level2]);
    expect(getSentencesForNode(root)).toEqual([10]);
  });

  it('ignores nodes where topic is null', () => {
    const leaf = makeLeaf('Tech>A', [1, 2]);
    const branchWithNullTopic = {
      node: { name: 'Tech', fullPath: 'Tech', depth: 0, topic: null },
      children: new Map([['A', leaf]]),
      parent: null,
    };
    getTopicSentenceNumbers.mockClear();
    expect(getSentencesForNode(branchWithNullTopic)).toEqual([1, 2]);
    expect(getTopicSentenceNumbers).toHaveBeenCalledTimes(1);
    expect(getTopicSentenceNumbers).not.toHaveBeenCalledWith(null);
  });

  it('handles an entry where children is undefined or null', () => {
    const entry = {
      node: { name: 'NoChildren', fullPath: 'NoChildren', depth: 0, topic: { sentences: [1] } },
      children: undefined,
      parent: null,
    };
    expect(getSentencesForNode(entry)).toEqual([1]);
  });

  it('returns a sorted result even when children are unordered', () => {
    const leaf1 = makeLeaf('Tech>Z', [9, 7]);
    const leaf2 = makeLeaf('Tech>A', [1, 3]);
    const branch = makeBranch('Tech', [leaf1, leaf2]);
    expect(getSentencesForNode(branch)).toEqual([1, 3, 7, 9]);
  });

  it('filters out 0 by default but preserves 0 when preserveZero is true', () => {
    const entry = makeLeaf('Tech>A', [0, 1, 2]);
    expect(getSentencesForNode(entry)).toEqual([1, 2]);
    expect(getSentencesForNode(entry, { preserveZero: true })).toEqual([0, 1, 2]);
  });
});

describe('getTopicSentenceNumbersRaw', () => {
  it('uses explicit sentenceIndices before sentence ranges, preserving zero and duplicates', () => {
    expect(
      getTopicSentenceNumbersRaw({
        sentenceIndices: [3, 0, 2, -1, 2, 1.5],
        ranges: [{ sentence_start: 10, sentence_end: 12 }],
      }),
    ).toEqual([0, 2, 2, 3]);
  });

  it('falls back to sentences when sentenceIndices are absent', () => {
    expect(getTopicSentenceNumbersRaw({ sentences: [4, 1, 0, 'x'] })).toEqual([0, 1, 4]);
  });

  it('expands valid ranges, handles reversed ranges, and ignores invalid ranges', () => {
    expect(
      getTopicSentenceNumbersRaw({
        ranges: [
          { sentence_start: 3, sentence_end: 5 },
          { sentence_start: 8, sentence_end: 6 },
          { sentence_start: -2, sentence_end: 1 },
          { sentence_start: 'bad', sentence_end: 10 },
        ],
      }),
    ).toEqual([0, 1, 3, 4, 5, 6, 7, 8]);
  });

  it('returns an empty array when no usable sentence data exists', () => {
    expect(getTopicSentenceNumbersRaw(null)).toEqual([]);
    expect(getTopicSentenceNumbersRaw({ sentenceIndices: [], ranges: null })).toEqual([]);
  });
});
