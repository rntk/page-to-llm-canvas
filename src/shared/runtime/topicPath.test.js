import { describe, it, expect } from 'vitest';
import {
  TOPIC_PATH_DELIMITER,
  TOPIC_PATH_DISPLAY_DELIMITER,
  ancestorPaths,
  formatTopicPath,
  isCanonicalDescendantPath,
  isDescendantPath,
  joinTopicPath,
  splitTopicPath,
} from './topicPath.js';

describe('splitTopicPath', () => {
  it('splits both the canonical and the display spelling', () => {
    expect(splitTopicPath('A>B>C')).toEqual(['A', 'B', 'C']);
    expect(splitTopicPath('A > B > C')).toEqual(['A', 'B', 'C']);
  });

  it('trims segments and drops blank ones', () => {
    expect(splitTopicPath('  A  >>  B  >  ')).toEqual(['A', 'B']);
  });

  it('coerces nullish input to an empty path', () => {
    expect(splitTopicPath(null)).toEqual([]);
    expect(splitTopicPath(undefined)).toEqual([]);
    expect(splitTopicPath('')).toEqual([]);
  });
});

describe('joiners', () => {
  it('keeps the wire and display forms distinct', () => {
    expect(joinTopicPath(['A', 'B'])).toBe('A>B');
    expect(formatTopicPath(['A', 'B'])).toBe('A > B');
    expect(TOPIC_PATH_DELIMITER).toBe('>');
    expect(TOPIC_PATH_DISPLAY_DELIMITER).toBe(' > ');
  });

  it('round-trips a path through either form', () => {
    const parts = splitTopicPath('Tech > AI > Agents');
    expect(splitTopicPath(joinTopicPath(parts))).toEqual(parts);
    expect(splitTopicPath(formatTopicPath(parts))).toEqual(parts);
  });
});

describe('ancestorPaths', () => {
  it('returns proper ancestors shallowest first, excluding the path itself', () => {
    expect(ancestorPaths('A > B > C')).toEqual(['A', 'A > B']);
    expect(ancestorPaths('A')).toEqual([]);
    expect(ancestorPaths('')).toEqual([]);
  });

  it('invents no ancestors for a non-display path', () => {
    // These results drive "has a descendant?" set membership, where a
    // fabricated ancestor silently drops a card from the rail.
    expect(ancestorPaths('A>B>C')).toEqual([]);
  });
});

describe('isDescendantPath', () => {
  it('matches strict descendants only', () => {
    expect(isDescendantPath('A > B', 'A')).toBe(true);
    expect(isDescendantPath('A > B > C', 'A > B')).toBe(true);
    expect(isDescendantPath('A', 'A')).toBe(false);
    expect(isDescendantPath('AB > C', 'A')).toBe(false);
    expect(isDescendantPath('', 'A')).toBe(false);
    expect(isDescendantPath('A > B', '')).toBe(false);
  });
});

describe('isCanonicalDescendantPath', () => {
  it('matches strict descendants on the wire form', () => {
    expect(isCanonicalDescendantPath('A>B', 'A')).toBe(true);
    expect(isCanonicalDescendantPath('A>B>C', 'A>B')).toBe(true);
    expect(isCanonicalDescendantPath('A', 'A')).toBe(false);
    expect(isCanonicalDescendantPath('AB>C', 'A')).toBe(false);
  });

  it('never treats the empty root path as an ancestor', () => {
    // The worker skips the empty root path; treating it as everything's
    // ancestor would pull the whole document into a single exclusion set.
    expect(isCanonicalDescendantPath('A>B', '')).toBe(false);
    expect(isCanonicalDescendantPath('', 'A')).toBe(false);
  });

  it('does not match across the display spelling', () => {
    expect(isCanonicalDescendantPath('A > B', 'A')).toBe(false);
  });
});
