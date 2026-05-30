import { describe, it, expect } from 'vitest';
import { toReadTopicsSet, isTopicRead } from './topicReadUtils.js';

describe('toReadTopicsSet', () => {
  it('returns a Set as-is', () => {
    const set = new Set(['a', 'b']);
    expect(toReadTopicsSet(set)).toBe(set);
  });

  it('returns an empty Set for null', () => {
    expect(toReadTopicsSet(null)).toEqual(new Set());
  });

  it('returns an empty Set for undefined', () => {
    expect(toReadTopicsSet(undefined)).toEqual(new Set());
  });

  it('converts an array to a Set', () => {
    expect(toReadTopicsSet(['x', 'y'])).toEqual(new Set(['x', 'y']));
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
});
