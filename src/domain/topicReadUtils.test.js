import { describe, it, expect } from 'vitest';
import { isTopicRead, normalizeReadTopics } from './topicReadUtils.js';

describe('normalizeReadTopics', () => {
  it('canonicalizes, removes empty paths, and deduplicates equivalent spellings', () => {
    expect(normalizeReadTopics(['Tech > AI', 'Tech>AI', '', null])).toEqual(new Set(['Tech>AI']));
  });

  // The live canvas path hands down a Set (`safeReadTopics`), not an array.
  it('collapses equivalent spellings supplied as a Set', () => {
    expect(normalizeReadTopics(new Set(['Tech > AI', 'Tech>AI', ' Tech>AI ']))).toEqual(
      new Set(['Tech>AI']),
    );
  });

  it('returns an empty set for inputs that are neither a Set nor an array', () => {
    expect(normalizeReadTopics(undefined)).toEqual(new Set());
    expect(normalizeReadTopics(null)).toEqual(new Set());
    // A bare string is iterable, but a single path is not a collection.
    expect(normalizeReadTopics('Tech>AI')).toEqual(new Set());
  });
});

describe('isTopicRead', () => {
  it('returns false for empty topic name', () => {
    expect(isTopicRead('', new Set(['Tech']))).toBe(false);
  });

  it('returns false for null topic name', () => {
    expect(isTopicRead(null, new Set(['Tech']))).toBe(false);
  });

  it('returns false when readTopics is empty', () => {
    expect(isTopicRead('Tech', new Set())).toBe(false);
  });

  it('returns false when readTopics is null', () => {
    expect(isTopicRead('Tech', null)).toBe(false);
  });

  it('returns true when the exact topic path is in the set', () => {
    expect(isTopicRead('Tech', new Set(['Tech']))).toBe(true);
  });

  it('returns true when a parent path is in the set', () => {
    expect(isTopicRead('Tech > AI', new Set(['Tech']))).toBe(true);
  });

  it('returns true when a mid-level ancestor is in the set', () => {
    expect(isTopicRead('A > B > C > D', new Set(['A>B>C']))).toBe(true);
  });

  it('returns false when only a child path is in the set', () => {
    expect(isTopicRead('Tech', new Set(['Tech>AI']))).toBe(false);
  });

  it('works with an array as readTopics input', () => {
    expect(isTopicRead('Tech > AI', ['Tech'])).toBe(true);
  });

  it('returns false for an unrelated topic', () => {
    expect(isTopicRead('Science', new Set(['Tech']))).toBe(false);
  });

  it('handles spaced topic paths', () => {
    expect(isTopicRead('Tech > AI > Models', new Set(['Tech']))).toBe(true);
  });

  it('returns true when the exact multi-level path is in the set', () => {
    expect(isTopicRead('Tech > AI', new Set(['Tech>AI']))).toBe(true);
  });

  it('normalizes spaced paths already present in readTopics', () => {
    expect(isTopicRead('Tech>AI', new Set(['Tech > AI']))).toBe(true);
  });
});
