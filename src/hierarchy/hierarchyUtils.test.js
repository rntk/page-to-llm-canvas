import { describe, it, expect, vi } from 'vitest';
import {
  getSentencesForNode,
  normalizeTopicPath,
  spacedTopicPath,
  buildSummaryLookup,
} from './hierarchyUtils.js';
import { getTopicSentenceNumbers } from '../domain/topicDomain.js';

vi.mock('../domain/topicDomain.js', async (importOriginal) => {
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
  it.each([
    ['returns empty array for a leaf node with no sentences', () => makeLeaf('Tech>Empty', []), []],
    [
      'returns sorted sentence numbers for a leaf node',
      () => makeLeaf('Tech>All', [3, 1, 2]),
      [1, 2, 3],
    ],
    [
      'collects sentences from all leaf descendants of a branch',
      () => {
        const leaf1 = makeLeaf('Tech>A', [1, 2]);
        const leaf2 = makeLeaf('Tech>B', [3, 4]);
        return makeBranch('Tech', [leaf1, leaf2]);
      },
      [1, 2, 3, 4],
    ],
    [
      'deduplicates sentence numbers shared across descendants',
      () => {
        const leaf1 = makeLeaf('Tech>A', [1, 2, 3]);
        const leaf2 = makeLeaf('Tech>B', [2, 3, 4]);
        return makeBranch('Tech', [leaf1, leaf2]);
      },
      [1, 2, 3, 4],
    ],
    [
      'includes own-topic sentences as well as children sentences',
      () => {
        const child = makeLeaf('Tech>A>Sub', [5, 6]);
        return {
          node: { name: 'A', fullPath: 'Tech>A', depth: 1, topic: { sentences: [1, 2] } },
          children: new Map([['Sub', child]]),
          parent: null,
        };
      },
      [1, 2, 5, 6],
    ],
    [
      'handles deeply nested hierarchy',
      () => {
        const deepLeaf = makeLeaf('A>B>C>D', [10]);
        const level3 = makeBranch('A>B>C', [deepLeaf]);
        const level2 = makeBranch('A>B', [level3]);
        return makeBranch('A', [level2]);
      },
      [10],
    ],
    [
      'handles an entry where children is undefined or null',
      () => ({
        node: { name: 'NoChildren', fullPath: 'NoChildren', depth: 0, topic: { sentences: [1] } },
        children: undefined,
        parent: null,
      }),
      [1],
    ],
    [
      'returns a sorted result even when children are unordered',
      () => {
        const leaf1 = makeLeaf('Tech>Z', [9, 7]);
        const leaf2 = makeLeaf('Tech>A', [1, 3]);
        return makeBranch('Tech', [leaf1, leaf2]);
      },
      [1, 3, 7, 9],
    ],
    ['filters out non-positive sentence numbers', () => makeLeaf('Tech>A', [0, 1, 2]), [1, 2]],
  ])('%s', (_description, buildEntry, expected) => {
    expect(getSentencesForNode(buildEntry())).toEqual(expected);
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
});

// ---------------------------------------------------------------------------
// normalizeTopicPath
// ---------------------------------------------------------------------------
describe('normalizeTopicPath', () => {
  it('joins parts with > and trims whitespace', () => {
    expect(normalizeTopicPath('Tech > AI > Models')).toBe('Tech>AI>Models');
  });

  it('handles a path with no separator', () => {
    expect(normalizeTopicPath('Tech')).toBe('Tech');
  });

  it('filters out empty segments from extra separators', () => {
    expect(normalizeTopicPath('>Tech>>AI>')).toBe('Tech>AI');
  });

  it('returns empty string for null or undefined', () => {
    expect(normalizeTopicPath(null)).toBe('');
    expect(normalizeTopicPath(undefined)).toBe('');
    expect(normalizeTopicPath('')).toBe('');
  });

  it('strips > from the title-safe representation', () => {
    // The .replace(/>/g, " ") pattern in TopicHierarchyView renders
    // normalised paths without > in title attributes.
    const normalized = normalizeTopicPath('Tech>AI>Models');
    expect(normalized.replace(/>/g, ' ')).toBe('Tech AI Models');
  });
});

// ---------------------------------------------------------------------------
// spacedTopicPath
// ---------------------------------------------------------------------------
describe('spacedTopicPath', () => {
  it("formats a path with ' > ' separator", () => {
    expect(spacedTopicPath('Tech>AI>Models')).toBe('Tech > AI > Models');
  });

  it('normalises input before formatting', () => {
    expect(spacedTopicPath('Tech > AI > Models')).toBe('Tech > AI > Models');
  });

  it('handles a single segment', () => {
    expect(spacedTopicPath('Tech')).toBe('Tech');
  });

  it('returns empty string for empty input', () => {
    expect(spacedTopicPath('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildSummaryLookup
// ---------------------------------------------------------------------------
describe('buildSummaryLookup', () => {
  it('returns an empty map when the index is null', () => {
    const lookup = buildSummaryLookup(null);
    expect(lookup.size).toBe(0);
  });

  it('ignores a non-object index', () => {
    const lookup = buildSummaryLookup('invalid');
    expect(lookup.size).toBe(0);
  });

  it('builds a lookup from topicSummaryIndex', () => {
    const index = { 'Sci>Bio': { runs: [{ text: 'Biology notes' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Sci>Bio')).toBe('Biology notes');
  });

  it('concatenates per-run text from a runs-shaped index entry', () => {
    const index = {
      'Sci>Bio': { runs: [{ text: 'Cells.' }, { text: 'Genes.' }] },
    };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Sci>Bio')).toBe('Cells. Genes.');
  });

  it('normalises a display-form index key to the canonical lookup key', () => {
    const index = { 'Tech > AI': { runs: [{ text: 'AI summary' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Tech>AI')).toBe('AI summary');
    expect(lookup.get('Tech > AI')).toBeUndefined();
  });

  it('skips entries with empty summary text', () => {
    const index = { 'Tech>AI': { runs: [] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.has('Tech>AI')).toBe(false);
  });

  it('skips entries with empty path', () => {
    const index = { '': { runs: [{ text: 'some text' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.has('')).toBe(false);
  });
});
